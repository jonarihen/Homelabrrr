import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateConfirmedCredit, calculateIntervalCost } from './costMath.ts';

const start = Date.parse('2026-10-08T00:00:00Z');
function time(minutes: number): Date { return new Date(start + minutes * 60_000); }

test('one kWh at 2.50 DKK/kWh costs 250 øre', () => {
  const result = calculateIntervalCost(
    [{ startUtc: time(0), endUtc: time(60), kwh: '1.000000000', coveredSeconds: 3600, expectedSeconds: 3600 }],
    [{ startUtc: time(0), endUtc: time(60), dkkPerKwh: '2.50', status: 'valid' }],
  );
  assert.equal(result.costOre, 250n);
  assert.equal(result.complete, true);
});

test('different prices are joined by interval rather than unweighted mean', () => {
  const result = calculateIntervalCost(
    [
      { startUtc: time(0), endUtc: time(15), kwh: '0.250000000', coveredSeconds: 900, expectedSeconds: 900 },
      { startUtc: time(15), endUtc: time(60), kwh: '0.750000000', coveredSeconds: 2700, expectedSeconds: 2700 },
    ],
    [
      { startUtc: time(0), endUtc: time(15), dkkPerKwh: '2.00', status: 'valid' },
      { startUtc: time(15), endUtc: time(60), dkkPerKwh: '4.00', status: 'valid' },
    ],
  );
  assert.equal(result.costOre, 350n);
  assert.equal(result.kwhPriced, '1.000000000');
});

test('price interval split conserves energy with explicit uniform apportionment', () => {
  const result = calculateIntervalCost(
    [{ startUtc: time(0), endUtc: time(15), kwh: '0.250000000', coveredSeconds: 900, expectedSeconds: 900 }],
    [
      { startUtc: time(0), endUtc: time(5), dkkPerKwh: '1.00', status: 'valid' },
      { startUtc: time(5), endUtc: time(15), dkkPerKwh: '4.00', status: 'valid' },
    ],
  );
  assert.equal(result.kwhPriced, '0.250000000');
  assert.equal(result.costOre, 75n);
  assert.equal(result.assumption, 'uniform_energy_within_interval');
});

test('missing price remains partial and is not valued at zero', () => {
  const result = calculateIntervalCost(
    [{ startUtc: time(0), endUtc: time(15), kwh: '0.250000000', coveredSeconds: 900, expectedSeconds: 900 }],
    [{ startUtc: time(0), endUtc: time(5), dkkPerKwh: '2.00', status: 'valid' }],
  );
  assert.equal(result.complete, false);
  assert.equal(result.priceCoveredSeconds, 300);
  assert.equal(result.kwhPriced, '0.083333333');
});

test('negative spot component and nonzero costs are represented exactly', () => {
  const result = calculateIntervalCost(
    [{ startUtc: time(0), endUtc: time(60), kwh: '1.000000000', coveredSeconds: 3600, expectedSeconds: 3600 }],
    [{ startUtc: time(0), endUtc: time(60), dkkPerKwh: '-0.50', status: 'valid' }],
  );
  assert.equal(result.costOre, -50n);
});

test('confirmed net credit funds at most cost and carries surplus', () => {
  assert.deepEqual(allocateConfirmedCredit(100_000n, 9_600n), {
    appliedOre: 9_600n, ownerRemainderOre: 90_400n, creditCarriedOre: 0n,
  });
  assert.deepEqual(allocateConfirmedCredit(100_000n, 120_000n), {
    appliedOre: 100_000n, ownerRemainderOre: 0n, creditCarriedOre: 20_000n,
  });
});

test('ambiguous price intervals and invalid coverage are refused', () => {
  const energy = [{ startUtc: time(0), endUtc: time(15), kwh: '0.25', coveredSeconds: 900, expectedSeconds: 900 }];
  const price = { startUtc: time(0), endUtc: time(10), dkkPerKwh: '2.00', status: 'valid' as const };
  assert.throws(() => calculateIntervalCost(energy, [price, { ...price, startUtc: time(5) }]), /Overlapping/);
  assert.throws(() => calculateIntervalCost([{ ...energy[0], coveredSeconds: 1000 }], [price]));
});
