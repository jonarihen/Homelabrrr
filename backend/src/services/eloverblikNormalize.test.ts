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
  assert.equal(rows[0].energy_kwh, '0.000000', 'a measured zero stays a known zero');
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
test('daily resolution follows Danish calendar days across DST transitions', () => {
  // 2026-10-25 is 25 hours long in Europe/Copenhagen, 2026-03-29 is 23 hours.
  const autumn = normalizeMeterSeries(envelope([{ resolution: 'P1D', timeInterval: { start: '2026-10-23T22:00:00Z', end: '2026-10-26T23:00:00Z' },
    Point: [1, 2, 3].map((position) => ({ position: String(position), 'out_Quantity.quantity': '10.5', 'out_Quantity.quality': 'A04' })) }]), meter);
  assert.deepEqual(autumn.map((row) => [row.interval_start.toISOString(), row.interval_end.toISOString()]), [
    ['2026-10-23T22:00:00.000Z', '2026-10-24T22:00:00.000Z'],
    ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    ['2026-10-25T23:00:00.000Z', '2026-10-26T23:00:00.000Z'],
  ]);
  const spring = normalizeMeterSeries(envelope([{ resolution: 'P1D', timeInterval: { start: '2026-03-28T23:00:00Z', end: '2026-03-29T22:00:00Z' },
    Point: [{ position: '1', 'out_Quantity.quantity': '9', 'out_Quantity.quality': 'A04' }] }]), meter);
  assert.equal(spring[0].interval_end.getTime() - spring[0].interval_start.getTime(), 23 * 3_600_000);
  assert.throws(() => normalizeMeterSeries(envelope([{ resolution: 'P1D', timeInterval: { start: '2026-03-29T00:00:00Z', end: '2026-03-30T00:00:00Z' },
    Point: [{ position: '1', 'out_Quantity.quantity': '9' }] }]), meter), /MALFORMED/, 'a daily period must start at local midnight');
});
test('an unparseable quantity becomes an unknown point instead of rejecting the chunk', () => {
  const values = ['1,25', 0.5, '0.1234567', 'n/a', '-1', '', '12'];
  const rows = normalizeMeterSeries(envelope([{ resolution: 'PT1H', timeInterval: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T07:00:00Z' },
    Point: values.map((value, index) => ({ position: String(index + 1), 'out_Quantity.quantity': value, 'out_Quantity.quality': 'A04' })) }]), meter);
  assert.equal(rows.length, values.length);
  assert.deepEqual(rows.map((row) => row.energy_kwh), ['1.250000', '0.500000', '0.123457', null, null, null, '12.000000']);
  assert.deepEqual(rows.map((row) => row.quality), ['A04', 'A04', 'A04', 'invalid_value', 'invalid_value', 'A04', 'A04']);
});
