import { parseDkkPerKwh } from './powerPolicy.ts';

// Turns Datahub (Energi Data Service `DatahubPricelist`) charge rows into the
// concrete, contiguous UTC intervals the `electricity_tariffs` table stores.
//
// A Datahub row carries 24 hourly rates (Price1 = local 00–01 … Price24 =
// local 23–24, Europe/Copenhagen) and a validity in local dates. Grid
// tariffs such as Cerius "Nettarif C time" differ by time of day and season,
// so an all-day average misprices both cost and price-based power control.
// Expansion walks real UTC hours: every Copenhagen offset is a whole hour, so
// each UTC hour starts on a local full hour. On the 23-hour spring-forward
// day local 02:00 never occurs; on the 25-hour fall-back day local 02:00
// occurs twice and both hours take that hour's rate.

export const TARIFF_TIME_ZONE = 'Europe/Copenhagen';
const HOUR_MS = 3_600_000;

export interface DatahubChargeRecord {
  ChargeOwner?: string;
  GLN_Number?: string;
  ChargeType: string;
  ChargeTypeCode: string;
  Note?: string;
  ValidFrom: string;
  ValidTo: string | null;
  [price: `Price${number}`]: number | null | undefined;
}
export interface HourlyTariffPeriod { startUtc: Date; endUtc: Date | null; rates: bigint[]; source: string }
export interface TariffInterval { startUtc: Date; endUtc: Date; micros: bigint }

const LOCAL_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: TARIFF_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function localParts(date: Date) {
  const parts = Object.fromEntries(LOCAL_PARTS.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
export function localHour(date: Date): number { return localParts(date).hour; }
function offsetMs(date: Date): number {
  const p = localParts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// UTC instant of a local wall-clock time in Copenhagen. Only used for
// midnight and other times that exist exactly once (never 02:00–03:00).
export function copenhagenWallTimeToUtc(year: number, month: number, day: number, hour = 0): Date {
  const naive = Date.UTC(year, month - 1, day, hour);
  let guess = naive - offsetMs(new Date(naive));
  guess = naive - offsetMs(new Date(guess));
  const check = localParts(new Date(guess));
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== 0) throw new Error('INVALID_LOCAL_TIME');
  return new Date(guess);
}

// Datahub ValidFrom/ValidTo are local date-times without an offset
// ("2026-10-01T00:00:00"). Tariff changes always take effect at local midnight.
export function parseDatahubLocalMidnight(value: string): Date {
  const match = /^(\d{4})-(\d\d)-(\d\d)T00:00(?::00)?$/.exec(value);
  if (!match) throw new Error(`INVALID_DATAHUB_DATE ${value}`);
  return copenhagenWallTimeToUtc(Number(match[1]), Number(match[2]), Number(match[3]));
}

function rateMicros(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('INVALID_DATAHUB_RATE');
  return parseDkkPerKwh(value.toFixed(6));
}
export function formatMicros(micros: bigint): string {
  const abs = micros < 0n ? -micros : micros;
  return `${micros < 0n ? '-' : ''}${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, '0')}`;
}

// Hourly periods for one charge code, sorted, with overlaps rejected. A row
// that publishes only Price1 is a flat rate for the whole day.
export function datahubPeriods(records: DatahubChargeRecord[], chargeTypeCode: string, chargeType = 'D03'): HourlyTariffPeriod[] {
  const periods = records.filter((row) => row.ChargeTypeCode === chargeTypeCode && row.ChargeType === chargeType).map((row) => {
    const flat = row.Price1;
    const rates = Array.from({ length: 24 }, (_, hour) => rateMicros(row[`Price${hour + 1}`] ?? flat));
    return { startUtc: parseDatahubLocalMidnight(row.ValidFrom), endUtc: row.ValidTo ? parseDatahubLocalMidnight(row.ValidTo) : null, rates,
      source: `${row.ChargeOwner ?? ''} ${chargeTypeCode} ${row.Note ?? ''} from ${row.ValidFrom}`.trim() };
  }).sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  for (let i = 0; i < periods.length; i++) {
    const end = periods[i].endUtc;
    if (end && end <= periods[i].startUtc) throw new Error(`INVALID_DATAHUB_PERIOD ${chargeTypeCode}`);
    if (i > 0 && (periods[i - 1].endUtc === null || periods[i - 1].endUtc! > periods[i].startUtc)) throw new Error(`OVERLAPPING_DATAHUB_PERIOD ${chargeTypeCode}`);
  }
  return periods;
}

// Per-UTC-hour rate for [windowStart, windowEnd). Hours no period covers are
// absent, so a later sum or merge can never invent a price for them.
export function hourlyRates(periods: HourlyTariffPeriod[], windowStart: Date, windowEnd: Date): Map<number, bigint> {
  if (windowStart.getTime() % HOUR_MS || windowEnd.getTime() % HOUR_MS) throw new Error('WINDOW_NOT_ON_HOUR');
  const result = new Map<number, bigint>();
  for (const period of periods) {
    const from = Math.max(period.startUtc.getTime(), windowStart.getTime());
    const to = Math.min(period.endUtc?.getTime() ?? windowEnd.getTime(), windowEnd.getTime());
    for (let at = from; at < to; at += HOUR_MS) result.set(at, period.rates[localHour(new Date(at))]);
  }
  return result;
}

// Adds components that are billed together (e.g. Energinet transmission +
// system tariff). An hour is kept only when every component covers it.
export function sumHourlyRates(...components: Map<number, bigint>[]): Map<number, bigint> {
  const [first, ...rest] = components;
  const result = new Map<number, bigint>();
  for (const [at, value] of first || []) {
    let total = value; let covered = true;
    for (const other of rest) { const add = other.get(at); if (add === undefined) { covered = false; break; } total += add; }
    if (covered) result.set(at, total);
  }
  return result;
}

// Merges consecutive equal-rate hours into intervals. A missing hour ends the
// current interval, so gaps stay visible instead of being bridged.
export function mergeHourlyRates(hours: Map<number, bigint>): TariffInterval[] {
  const keys = [...hours.keys()].sort((a, b) => a - b);
  const intervals: TariffInterval[] = [];
  for (const at of keys) {
    const micros = hours.get(at)!;
    const last = intervals[intervals.length - 1];
    if (last && last.endUtc.getTime() === at && last.micros === micros) last.endUtc = new Date(at + HOUR_MS);
    else intervals.push({ startUtc: new Date(at), endUtc: new Date(at + HOUR_MS), micros });
  }
  return intervals;
}

// Contiguous coverage check: sorted, no overlap and no gap between intervals.
export function assertContiguous(intervals: TariffInterval[]): void {
  for (let i = 1; i < intervals.length; i++) {
    const previous = intervals[i - 1].endUtc.getTime(); const next = intervals[i].startUtc.getTime();
    if (next < previous) throw new Error(`TARIFF_INTERVAL_OVERLAP at ${intervals[i].startUtc.toISOString()}`);
    if (next > previous) throw new Error(`TARIFF_INTERVAL_GAP ${intervals[i - 1].endUtc.toISOString()} → ${intervals[i].startUtc.toISOString()}`);
  }
}
