import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const { estimatedLoadKwh, extraLoadInterval, forecastExtraLoadCost, createExtraLabLoad } = await import('./extraLabLoads.ts');

const load = (from: string, to: string) => ({ id: 1, source_key: 'switch-rack', label: 'Rack switch',
  estimated_watts: '100.000', valid_from: new Date(from), valid_to: new Date(to), provenance: 'metered separately' });

test('constant watt estimates follow actual UTC duration, including Danish DST days', () => {
  const spring = load('2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z');
  const autumn = load('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z');
  assert.equal(estimatedLoadKwh(spring.estimated_watts, spring.valid_from, spring.valid_to, spring.valid_from, spring.valid_to), '2.300000000');
  assert.equal(estimatedLoadKwh(autumn.estimated_watts, autumn.valid_from, autumn.valid_to, autumn.valid_from, autumn.valid_to), '2.500000000');
  assert.equal(extraLoadInterval(spring, new Date('2026-03-29T00:00:00Z'), new Date('2026-03-29T12:00:00Z'))?.kwh, '1.200000000');
  assert.equal(extraLoadInterval(spring, new Date('2026-03-30T00:00:00Z'), new Date('2026-03-31T00:00:00Z')), null);
});

test('future extra-load cost uses published intervals then a labeled scenario without double counting', () => {
  const start = new Date('2026-10-08T00:00:00Z'); const middle = new Date('2026-10-08T12:00:00Z'); const end = new Date('2026-10-09T00:00:00Z');
  const scheduled = [load(start.toISOString(), end.toISOString())];
  const published = [{ startUtc: start, endUtc: middle, dkkPerKwh: '2.000000', status: 'valid' as const }];
  assert.deepEqual(forecastExtraLoadCost(scheduled, start, end, published, '4.000000'), {
    costOre: 720n, complete: true, kwhPriced: ['2.400000000'], loadCount: 1,
  });
  assert.deepEqual(forecastExtraLoadCost(scheduled, start, end, published, null), {
    costOre: 240n, complete: false, kwhPriced: ['1.200000000'], loadCount: 1,
  });
});

test('inclusive sources and missing non-overlap attestation are rejected before persistence', async () => {
  const base = { sourceKey: 'ups-rack', label: 'UPS overhead', estimatedWatts: '25.000',
    validFrom: '2026-10-01T00:00:00Z', validTo: '2026-11-01T00:00:00Z', provenance: 'separate estimate',
    excludesServerEnergy: true, sourceScope: 'incremental_excluding_servers' };
  await assert.rejects(createExtraLabLoad({ ...base, excludesServerEnergy: false }), /INVALID_EXTRA_LOAD/);
  await assert.rejects(createExtraLabLoad({ ...base, sourceScope: 'inclusive_upstream' }), /INVALID_EXTRA_LOAD/);
  await assert.rejects(createExtraLabLoad({ ...base, estimatedWatts: '0' }), /INVALID_EXTRA_LOAD_WATTS/);
});
