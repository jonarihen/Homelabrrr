import { ElOverblikError } from './eloverblikClient.ts';
import { startOfLocalDateUtc } from './energyAccounting.ts';

export type MeterInterval = {
  meter_id: string;
  series_key: string;
  business_type: string;
  aggregation: string;
  resolution: string;
  interval_start: Date;
  interval_end: Date;
  energy_kwh: string | null;
  quality: string | null;
  fetched_at: Date;
};

const RESOLUTION_MS: Record<string, number> = { PT15M: 900_000, PT1H: 3_600_000 };
const LOCAL_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' });
const STORED_SCALE = 6;
export const INVALID_VALUE_QUALITY = 'invalid_value';

function localDate(date: Date): string { return LOCAL_DATE.format(date); }
function addLocalDays(local: string, days: number): string {
  const [year, month, day] = local.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// Daily positions follow Danish calendar days, which are 23 or 25 hours long
// on DST transition days; a fixed 24 h width would drift by an hour.
function pointInterval(resolution: string, periodStart: Date, position: number): { start: Date; end: Date } | null {
  if (resolution === 'P1D') {
    const firstDay = localDate(periodStart);
    if (startOfLocalDateUtc(firstDay).getTime() !== periodStart.getTime()) throw new ElOverblikError('MALFORMED');
    return { start: startOfLocalDateUtc(addLocalDays(firstDay, position - 1)), end: startOfLocalDateUtc(addLocalDays(firstDay, position)) };
  }
  const width = RESOLUTION_MS[resolution];
  if (!width) return null;
  const start = new Date(periodStart.getTime() + (position - 1) * width);
  return { start, end: new Date(start.getTime() + width) };
}

// Tolerant quantity parsing: a single unparseable point becomes an unknown
// (null) value flagged in quality instead of rejecting the whole chunk.
// Accepts JSON numbers and a decimal comma; extra decimals are rounded
// half-up to the stored 6 decimal places. Negative or non-numeric consumption
// is never coerced to zero.
export function normalizeQuantity(raw: unknown): { value: string | null; invalid: boolean } {
  if (raw === null || raw === undefined || raw === '') return { value: null, invalid: false };
  let text = '';
  if (typeof raw === 'number') text = Number.isFinite(raw) && raw >= 0 ? raw.toFixed(9).replace(/\.?0+$/, '') : '';
  else if (typeof raw === 'string') text = raw.trim().replace(',', '.');
  const match = /^(\d{1,14})(?:\.(\d+))?$/.exec(text);
  if (!match) return { value: null, invalid: true };
  const [, whole, fraction = ''] = match;
  let scaled = BigInt(whole) * 10n ** BigInt(STORED_SCALE) + BigInt(fraction.slice(0, STORED_SCALE).padEnd(STORED_SCALE, '0'));
  if (fraction.length > STORED_SCALE && Number(fraction[STORED_SCALE]) >= 5) scaled += 1n;
  const unit = 10n ** BigInt(STORED_SCALE);
  return { value: `${scaled / unit}.${String(scaled % unit).padStart(STORED_SCALE, '0')}`, invalid: false };
}

export function normalizeMeterSeries(envelope: unknown, meterId: string, fetchedAt = new Date()): MeterInterval[] {
  if (!envelope || typeof envelope !== 'object' || !Array.isArray((envelope as any).result)) throw new ElOverblikError('MALFORMED');
  const result = (envelope as any).result;
  const own = result.filter((item: any) => item?.id === meterId);
  if (own.length !== 1) throw new ElOverblikError(own.length ? 'AMBIGUOUS_METER' : 'METER_MISSING');
  const item = own[0];
  if (item.success !== true) throw new ElOverblikError(`UPSTREAM_${Number(item.errorCode) || 'UNKNOWN'}`);
  const document = item.MyEnergyData_MarketDocument;
  if (!document || !Array.isArray(document.TimeSeries)) throw new ElOverblikError('MALFORMED');
  const intervals: MeterInterval[] = [];
  for (const series of document.TimeSeries) {
    const businessType = String(series?.businessType || '');
    const unit = String(series?.['measurement_Unit.name'] || '');
    if (!['A04', 'A64'].includes(businessType) || unit.toLowerCase() !== 'kwh') continue;
    if (series?.mRID !== meterId) throw new ElOverblikError('METER_MISMATCH');
    const seriesKey = `${businessType}:${unit}:${String(series.curveType || '')}`;
    if (!Array.isArray(series.Period)) throw new ElOverblikError('MALFORMED');
    for (const period of series.Period) {
      const resolution = String(period?.resolution || '');
      if (!RESOLUTION_MS[resolution] && resolution !== 'P1D') throw new ElOverblikError('UNSUPPORTED_RESOLUTION');
      const start = new Date(period?.timeInterval?.start);
      const end = new Date(period?.timeInterval?.end);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new ElOverblikError('MALFORMED');
      if (!Array.isArray(period.Point)) throw new ElOverblikError('MALFORMED');
      for (const point of period.Point) {
        const position = Number(point?.position);
        if (!Number.isSafeInteger(position) || position < 1 || position > 10_000) throw new ElOverblikError('MALFORMED');
        const interval = pointInterval(resolution, start, position)!;
        if (interval.end > end) throw new ElOverblikError('MALFORMED');
        const quantity = normalizeQuantity(point?.['out_Quantity.quantity']);
        const sourceQuality = point?.['out_Quantity.quality'] == null ? null : String(point['out_Quantity.quality']).slice(0, 32);
        intervals.push({ meter_id: meterId, series_key: seriesKey, business_type: businessType, aggregation: 'Actual', resolution,
          interval_start: interval.start, interval_end: interval.end, energy_kwh: quantity.value,
          quality: quantity.invalid ? INVALID_VALUE_QUALITY : sourceQuality, fetched_at: fetchedAt });
      }
    }
  }
  const keys = new Set(intervals.map((entry) => `${entry.series_key}:${entry.interval_start.toISOString()}`));
  if (keys.size !== intervals.length) throw new ElOverblikError('AMBIGUOUS_SERIES');
  return intervals;
}
