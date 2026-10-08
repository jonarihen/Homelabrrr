import { ElOverblikError } from './eloverblikClient.ts';

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

const RESOLUTION_MS: Record<string, number> = { PT15M: 900_000, PT1H: 3_600_000, P1D: 86_400_000 };
const DECIMAL = /^\d+(?:\.\d{1,6})?$/;

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
      const width = RESOLUTION_MS[resolution];
      if (!width) throw new ElOverblikError('UNSUPPORTED_RESOLUTION');
      const start = new Date(period?.timeInterval?.start);
      const end = new Date(period?.timeInterval?.end);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new ElOverblikError('MALFORMED');
      if (!Array.isArray(period.Point)) throw new ElOverblikError('MALFORMED');
      for (const point of period.Point) {
        const position = Number(point?.position);
        if (!Number.isSafeInteger(position) || position < 1) throw new ElOverblikError('MALFORMED');
        const intervalStart = new Date(start.getTime() + (position - 1) * width);
        const intervalEnd = new Date(intervalStart.getTime() + width);
        if (intervalEnd > end) throw new ElOverblikError('MALFORMED');
        const raw = point['out_Quantity.quantity'];
        const energy = raw == null ? null : String(raw);
        if (energy !== null && !DECIMAL.test(energy)) throw new ElOverblikError('MALFORMED');
        intervals.push({ meter_id: meterId, series_key: seriesKey, business_type: businessType, aggregation: 'Actual', resolution,
          interval_start: intervalStart, interval_end: intervalEnd, energy_kwh: energy, quality: point['out_Quantity.quality'] == null ? null : String(point['out_Quantity.quality']), fetched_at: fetchedAt });
      }
    }
  }
  const keys = new Set(intervals.map((entry) => `${entry.series_key}:${entry.interval_start.toISOString()}`));
  if (keys.size !== intervals.length) throw new ElOverblikError('AMBIGUOUS_SERIES');
  return intervals;
}
