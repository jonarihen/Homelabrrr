import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMeterSeries } from './eloverblikNormalize.ts';

const meter = '571313180000000001';
function envelope(periods: any[], businessType = 'A04') {
  return { result: [{ id: meter, success: true, MyEnergyData_MarketDocument: { TimeSeries: [{ mRID: meter,
    businessType, curveType: 'A01', 'measurement_Unit.name': 'kWh', Period: periods }] } }] };
}
test('normalizes quarter hour intervals across repeated Danish DST hour by UTC position', () => {
  const rows = normalizeMeterSeries(envelope([{ resolution: 'PT15M', timeInterval: { start: '2026-10-25T00:00:00Z', end: '2026-10-25T02:00:00Z' },
    Point: Array.from({ length: 8 }, (_, i) => ({ position: String(i + 1), 'out_Quantity.quantity': i === 0 ? '0' : '0.125', 'out_Quantity.quality': 'A04' })) }] ), meter);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].energy_kwh, '0');
  assert.equal(rows[4].interval_start.toISOString(), '2026-10-25T01:00:00.000Z');
  assert.equal(rows[7].interval_end.toISOString(), '2026-10-25T02:00:00.000Z');
});
test('keeps missing quantity unknown and rejects duplicate provider points', () => {
  const period = { resolution: 'PT1H', timeInterval: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T02:00:00Z' },
    Point: [{ position: '1', 'out_Quantity.quantity': null, 'out_Quantity.quality': 'A02' }] };
  assert.equal(normalizeMeterSeries(envelope([period]), meter)[0].energy_kwh, null);
  assert.throws(() => normalizeMeterSeries(envelope([period, period]), meter), /AMBIGUOUS_SERIES/);
});
test('excludes generation series and refuses successful malformed envelope', () => {
  assert.equal(normalizeMeterSeries(envelope([], 'A01'), meter).length, 0);
  assert.throws(() => normalizeMeterSeries({ result: [{ id: meter, success: true }] }, meter), /MALFORMED/);
});
