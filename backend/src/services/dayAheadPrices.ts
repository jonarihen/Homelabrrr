import { createHash } from 'node:crypto';
import { parseDkkPerKwh } from './powerPolicy.ts';

const SOURCE = 'https://api.energidataservice.dk/dataset/DayAheadPrices';
const MAX_BYTES = 2 * 1024 * 1024;
const QUARTER_MS = 15 * 60_000;
const LOCAL_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function localQueryTime(date: Date): string {
  const parts = LOCAL_DATE_TIME.formatToParts(date);
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
export interface DayAheadRow { area: 'DK1' | 'DK2'; startUtc: Date; endUtc: Date; dkkPerKwh: string; sourceRevision: string }
export class DayAheadError extends Error {
  code: string;
  retryAfterMs: number | null;
  constructor(code: string, retryAfterMs: number | null = null) { super(`Day-ahead price fetch failed (${code})`); this.code = code; this.retryAfterMs = retryAfterMs; }
}
function decimalMwhToKwh(value: unknown): string {
  const text = String(value);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) throw new DayAheadError('INVALID_RATE');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const millionthsMwh = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
  const rounded = (millionthsMwh + 500n) / 1000n; // DKK/MWh to millionths DKK/kWh
  const signed = negative ? -rounded : rounded;
  const absolute = signed < 0n ? -signed : signed;
  const result = `${signed < 0n ? '-' : ''}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, '0')}`;
  parseDkkPerKwh(result);
  return result;
}
export function parseDayAheadRecords(body: unknown, area: 'DK1' | 'DK2'): DayAheadRow[] {
  const records = (body as { records?: unknown })?.records;
  if (!Array.isArray(records) || records.length > 400) throw new DayAheadError('INVALID_RESPONSE');
  const rows = records.map((record: any) => {
    if (record?.PriceArea !== area || typeof record.TimeUTC !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)?$/.test(record.TimeUTC)) throw new DayAheadError('INVALID_RECORD');
    const utc = /(?:Z|[+-]\d\d:\d\d)$/.test(record.TimeUTC) ? record.TimeUTC : `${record.TimeUTC}Z`;
    const startUtc = new Date(utc);
    if (!Number.isFinite(startUtc.getTime()) || startUtc.getTime() % QUARTER_MS !== 0) throw new DayAheadError('INVALID_INTERVAL');
    return { area, startUtc, endUtc: new Date(startUtc.getTime() + QUARTER_MS), dkkPerKwh: decimalMwhToKwh(record.DayAheadPriceDKK),
      sourceRevision: createHash('sha256').update(`${area}:${startUtc.toISOString()}:${record.DayAheadPriceDKK}`).digest('hex').slice(0, 24) };
  }).sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  for (let i = 1; i < rows.length; i++) if (rows[i].startUtc <= rows[i - 1].startUtc) throw new DayAheadError('DUPLICATE_INTERVAL');
  return rows;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new DayAheadError('OVERSIZED');
  const reader = response.body?.getReader();
  if (!reader) throw new DayAheadError('INVALID_RESPONSE');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_BYTES) throw new DayAheadError('OVERSIZED'); chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new DayAheadError('INVALID_RESPONSE'); }
}
export async function fetchDayAheadPrices(area: 'DK1' | 'DK2', at = new Date(), fetcher: typeof fetch = fetch): Promise<DayAheadRow[]> {
  if (!['DK1', 'DK2'].includes(area) || !Number.isFinite(at.getTime())) throw new DayAheadError('INVALID_REQUEST');
  // Two UTC days bound each request. The data source may return future-published
  // prices; absence before publication stays missing in the cache.
  const start = new Date(at.getTime() - 24 * 3600_000);
  const end = new Date(at.getTime() + 24 * 3600_000);
  // EDS interprets API range parameters as Copenhagen local wall time and
  // rejects ISO strings with a UTC suffix. Record TimeUTC remains the instant
  // used for storage, so DST does not create duplicate interval identities.
  const params = new URLSearchParams({ start: localQueryTime(start), end: localQueryTime(end), filter: JSON.stringify({ PriceArea: [area] }), sort: 'TimeUTC', limit: '400' });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(`${SOURCE}?${params}`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      const retry = Number(response.headers.get('retry-after'));
      throw new DayAheadError(response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`, response.status === 429 && Number.isFinite(retry) ? Math.min(6 * 3600_000, retry * 1000) : null);
    }
    return parseDayAheadRecords(await boundedJson(response), area);
  } catch (err) { if (err instanceof DayAheadError) throw err; throw new DayAheadError('NETWORK'); }
  finally { clearTimeout(timeout); }
}
