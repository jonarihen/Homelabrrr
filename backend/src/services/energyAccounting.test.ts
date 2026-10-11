import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHouseholdEnergy, allocateFixedFee, forecastMonthlyCost, startOfLocalDateUtc } from './energyAccounting.ts';

test('household comparison never adds embedded server use', () => {
  const share = compareHouseholdEnergy('100.000000000', '500.000000000', 3600, 3600, 3600, 'household');
  assert.equal(share.labShare, '0.200000');
  assert.equal(allocateFixedFee(1000n, { mode: 'energy_proportion' }, share).allocatedOre, 200n);
  assert.equal(allocateFixedFee(1000n, { mode: 'none' }, share).allocatedOre, 0n);
  assert.equal(compareHouseholdEnergy('600.000000000', '500.000000000', 3600, 3600, 3600, 'household').status, 'scope_mismatch');
  assert.equal(compareHouseholdEnergy('100.000000000', '500.000000000', 1800, 3600, 3600, 'household').status, 'partial');
  assert.equal(compareHouseholdEnergy('100.000000000', '500.000000000', 3600, 3600, 3600, 'dedicated_lab').status, 'dedicated_meter');
});

test('forecast requires both weekday/weekend evidence and an explicit scenario price', () => {
  const days = Array.from({ length: 21 }, (_, i) => ({ localDate: new Date(Date.UTC(2026, 8, 14 + i)).toISOString().slice(0, 10), kwh: '1.000000000', coveredSeconds: 86400, expectedSeconds: 86400 }));
  const input = { now: new Date('2026-10-08T12:00:00Z'), month: '2026-10', actualCostOre: 1000n, dailyEvidence: days, scenarioDkkPerKwh: '2.000000' };
  const result = forecastMonthlyCost(input);
  assert.equal(result.status, 'scenario');
  assert.ok(result.forecastTotalOre! > result.actualCostOre);
  const known = forecastMonthlyCost({ ...input, knownFuturePrices: [{ startUtc: new Date('2026-10-08T12:00:00Z'), endUtc: new Date('2026-10-08T12:15:00Z'), dkkPerKwh: '1.000000', status: 'valid' }] });
  assert.equal(known.priceBasis, 'published_and_scenario');
  assert.equal(known.knownPriceSeconds, 900);
  assert.equal(forecastMonthlyCost({ ...input, scenarioDkkPerKwh: null }).status, 'missing_price_scenario');
  assert.equal(forecastMonthlyCost({ ...input, dailyEvidence: days.slice(0, 5) }).status, 'insufficient_data');
});

test('Copenhagen DST days can carry 23 or 25 hours of evidence without a 24-hour assumption', () => {
  assert.equal((startOfLocalDateUtc('2026-03-30').getTime() - startOfLocalDateUtc('2026-03-29').getTime()) / 3600_000, 23);
  assert.equal((startOfLocalDateUtc('2026-10-26').getTime() - startOfLocalDateUtc('2026-10-25').getTime()) / 3600_000, 25);
  const share = compareHouseholdEnergy('1.000000000', '4.000000000', 23 * 3600, 23 * 3600, 23 * 3600, 'household');
  assert.equal(share.status, 'comparable');
  const autumn = compareHouseholdEnergy('1.000000000', '4.000000000', 25 * 3600, 25 * 3600, 25 * 3600, 'household');
  assert.equal(autumn.status, 'comparable');
});
