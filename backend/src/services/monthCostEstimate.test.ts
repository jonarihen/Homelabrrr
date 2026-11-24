import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMissingSpot, estimateRange, estimateServerMonth, type EstimateBucket, type EstimatePrice, type ServerEstimateInput } from './monthCostEstimate.ts';

// November 2026 in Europe/Copenhagen (CET, no DST change inside the month).
const START = new Date('2026-10-31T23:00:00Z');
const END = new Date('2026-11-30T23:00:00Z');
const QUARTER = 900_000;
const DAY = 86_400_000;
const day = (n: number) => new Date(START.getTime() + n * DAY);
const localHour = (at: number) => (new Date(at).getUTCHours() + 1) % 24;

function buckets(from: Date, to: Date, kwh: (at: number) => number, hardwareId = 1): EstimateBucket[] {
  const rows: EstimateBucket[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += QUARTER) rows.push({ hardwareId, startUtc: new Date(at), endUtc: new Date(at + QUARTER), kwh: kwh(at).toFixed(9), coveredSeconds: 900, expectedSeconds: 900 });
  return rows;
}
function prices(from: Date, to: Date, rate: (at: number) => number, estimated: (at: number) => boolean = () => false): EstimatePrice[] {
  const rows: EstimatePrice[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += QUARTER) rows.push({ startUtc: new Date(at), endUtc: new Date(at + QUARTER), dkkPerKwh: rate(at).toFixed(6), estimated: estimated(at) });
  return rows;
}
function input(overrides: Partial<ServerEstimateInput> = {}): ServerEstimateInput {
  return { now: day(3), monthStart: START, monthEnd: END, hosts: [{ hardwareId: 1, from: START }], buckets: buckets(START, day(3), () => 0.1),
    prices: prices(START, END, () => 2), spotSpreadDkkPerKwh: 0, spotHistoryDays: 0, spotToRetail: 1.25, ...overrides };
}
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} is not within ${tolerance} of ${expected}`);

test('a steady server at a known price projects the remaining days exactly', () => {
  const result = estimateServerMonth(input());
  assert.equal(result.status, 'estimated');
  near(result.unmeasuredOre, 0);
  near(result.remainingOre, 27 * 96 * 0.1 * 2 * 100);
  near(result.estimatedKwh, 27 * 96 * 0.1);
  near(result.basisDays, 3);
  near(result.sigmaOre, 0);
  assert.equal(result.estimatedSpotKwh, 0);
});

test('time before monitoring started is filled in, but never before the server was known', () => {
  const lateStart = buckets(day(1), day(3), () => 0.1);
  const filled = estimateServerMonth(input({ buckets: lateStart }));
  near(filled.unmeasuredOre, 96 * 0.1 * 2 * 100);
  near(filled.remainingOre, 27 * 96 * 0.1 * 2 * 100);
  const newServer = estimateServerMonth(input({ buckets: lateStart, hosts: [{ hardwareId: 1, from: day(1) }] }));
  near(newServer.unmeasuredOre, 0);
});

test('a partly covered quarter-hour is only topped up for its missing seconds', () => {
  const rows = buckets(START, day(3), () => 0.1);
  rows[10] = { ...rows[10], kwh: '0.050000000', coveredSeconds: 450 };
  const result = estimateServerMonth(input({ buckets: rows }));
  // 450 missing seconds at the profile rate (0.1 kWh per 900 s) and 2 DKK/kWh.
  near(result.unmeasuredOre, 0.05 * 2 * 100, 1e-3);
});

test('load and price are matched hour by hour, not averaged over the day', () => {
  // Evening-heavy load meeting an evening price peak costs more than the
  // daily averages multiplied together.
  const load = (at: number) => localHour(at) >= 17 && localHour(at) < 21 ? 0.3 : 0.05;
  const rate = (at: number) => localHour(at) >= 17 && localHour(at) < 21 ? 4 : 1;
  const result = estimateServerMonth(input({ now: day(14), buckets: buckets(START, day(14), load), prices: prices(START, END, rate) }));
  const perDay = 16 * (0.3 * 4) + 80 * (0.05 * 1);
  const averaged = (16 * 0.3 + 80 * 0.05) * ((16 * 4 + 80 * 1) / 96);
  near(result.remainingOre, 16 * perDay * 100, 0.02);
  assert.ok(result.remainingOre > 16 * averaged * 100 * 1.5);
});

test('recent readings outweigh older ones after a change in consumption', () => {
  const load = (at: number) => at < day(10).getTime() ? 0.1 : 0.2;
  const result = estimateServerMonth(input({ now: day(14), buckets: buckets(START, day(14), load) }));
  const perBucket = result.estimatedKwh / (16 * 96);
  const plainAverage = (10 * 0.1 + 4 * 0.2) / 14;
  assert.ok(perBucket > plainAverage * 1.08 && perBucket < 0.2, `expected more than the plain average ${plainAverage}, got ${perBucket}`);
});

test('weekend and weekday profiles are kept apart', () => {
  // 2026-11-07 and 08 are a weekend; day(n) starts local 00:00 of November n+1.
  const weekend = (at: number) => [6, 0].includes(new Date(at + 3_600_000).getUTCDay());
  const result = estimateServerMonth(input({ now: day(14), buckets: buckets(START, day(14), (at) => weekend(at) ? 0.3 : 0.1) }));
  // Remaining: Nov 15 (Sun) + Nov 21, 22, 28, 29 = 5 weekend days, 11 weekdays.
  near(result.estimatedKwh, 96 * (5 * 0.3 + 11 * 0.1), 0.02);
});

test('less than a day of readings, or no monitored server, gives no estimate', () => {
  assert.equal(estimateServerMonth(input({ buckets: buckets(day(2), new Date(day(2).getTime() + 23 * 3_600_000), () => 0.1), now: day(3) })).status, 'insufficient_data');
  assert.equal(estimateServerMonth(input({ hosts: [] })).status, 'insufficient_data');
  assert.equal(estimateServerMonth(input({ hosts: [{ hardwareId: 1, from: START }, { hardwareId: 2, from: START }] })).status, 'insufficient_data');
});

test('a missing price fails closed instead of being treated as free', () => {
  assert.equal(estimateServerMonth(input({ prices: prices(START, day(20), () => 2) })).status, 'price_unavailable');
  // Measured energy in an unpriced hour also blocks the estimate.
  assert.equal(estimateServerMonth(input({ prices: prices(day(1), END, () => 2) })).status, 'price_unavailable');
});

test('measured energy without a published price is priced with the estimated one', () => {
  const result = estimateServerMonth(input({ prices: prices(START, END, () => 2, (at) => at < day(1).getTime()) }));
  near(result.unmeasuredOre, 96 * 0.1 * 2 * 100);
  assert.equal(result.estimatedSpotKwh, 0, 'measured energy is not estimated energy');
});

test('the range widens with day-to-day variation and with estimated prices', () => {
  const noisy = (at: number) => 0.1 * (1 + 0.2 * Math.sign(Math.sin(Math.floor((at - START.getTime()) / DAY) * 2.4)));
  const steady = estimateServerMonth(input({ now: day(10), buckets: buckets(START, day(10), () => 0.1) }));
  const varying = estimateServerMonth(input({ now: day(10), buckets: buckets(START, day(10), noisy) }));
  near(steady.sigmaOre, 0);
  assert.ok(varying.sigmaOre > 0.05 * varying.remainingOre, `expected a visible spread, got ${varying.sigmaOre} on ${varying.remainingOre}`);
  const guessed = estimateServerMonth(input({ now: day(10), buckets: buckets(START, day(10), () => 0.1),
    prices: prices(START, END, () => 2, (at) => at >= day(11).getTime()), spotSpreadDkkPerKwh: 0.3, spotHistoryDays: 10 }));
  near(guessed.estimatedSpotKwh, 19 * 96 * 0.1);
  // 182.4 kWh x 0.3 DKK x 1.25 VAT x sqrt(0.5 + 0.5/19 + 1/10) x 100 øre.
  near(guessed.sigmaOre, 19 * 96 * 0.1 * 0.3 * 1.25 * Math.sqrt(0.5 + 0.5 / 19 + 0.1) * 100, 1e-6);
});

test('two servers are estimated separately and added', () => {
  const both = [...buckets(START, day(3), () => 0.1, 1), ...buckets(day(1), day(3), () => 0.2, 2)];
  const result = estimateServerMonth(input({ buckets: both, hosts: [{ hardwareId: 1, from: START }, { hardwareId: 2, from: START }] }));
  near(result.unmeasuredOre, 96 * 0.2 * 2 * 100);
  near(result.remainingOre, 27 * 96 * 0.3 * 2 * 100);
  near(result.basisDays, 2);
});

test('missing spot is estimated per local hour only where nothing is published', () => {
  const spot = (at: number) => localHour(at) >= 17 && localHour(at) < 21 ? 1.5 : 0.5;
  const published = prices(day(1), day(8), spot).map((row) => ({ startUtc: row.startUtc, endUtc: row.endUtc, dkkPerKwh: row.dkkPerKwh }));
  const guess = estimateMissingSpot(published, day(7), START, END)!;
  assert.equal(guess.historyDays, 7);
  near(guess.spreadDkkPerKwh, 0);
  const total = guess.rows.reduce((sum, row) => sum + row.endUtc.getTime() - row.startUtc.getTime(), 0);
  assert.equal(total, 23 * DAY, 'the first day and the 22 days after the published week');
  assert.ok(guess.rows.every((row) => row.endUtc <= day(1) || row.startUtc >= day(8)), 'published quarter-hours are never replaced');
  const at = (when: Date) => Number(guess.rows.find((row) => row.startUtc <= when && when < row.endUtc)!.dkkPerKwh);
  near(at(new Date(day(20).getTime() + 18 * 3_600_000)), 1.5, 0.05);
  near(at(new Date(day(20).getTime() + 3 * 3_600_000)), 0.5, 0.05);
  assert.ok(guess.rows.length <= 23 * 24, 'quarter-hours of one hour are merged into a single row');
});

test('spot estimation needs a day of history and reports the daily spread', () => {
  const few = prices(day(1), new Date(day(1).getTime() + 23 * 3_600_000), () => 1).map((row) => ({ startUtc: row.startUtc, endUtc: row.endUtc, dkkPerKwh: row.dkkPerKwh }));
  assert.equal(estimateMissingSpot(few, day(2), START, END), null);
  const levels = [0.4, 0.6, 0.8, 1.0];
  const varying = prices(START, day(4), (at) => levels[Math.floor((at - START.getTime()) / DAY)]).map((row) => ({ startUtc: row.startUtc, endUtc: row.endUtc, dkkPerKwh: row.dkkPerKwh }));
  const guess = estimateMissingSpot(varying, day(4), START, END)!;
  near(guess.spreadDkkPerKwh, Math.sqrt((0.09 + 0.01 + 0.01 + 0.09) / 3), 1e-6);
  const negative = estimateMissingSpot(prices(START, day(2), () => -0.25).map((row) => ({ startUtc: row.startUtc, endUtc: row.endUtc, dkkPerKwh: row.dkkPerKwh })), day(2), START, END)!;
  assert.equal(negative.rows[0].dkkPerKwh, '-0.250000');
});

test('the range is symmetric but never drops below what is already known', () => {
  assert.deepEqual(estimateRange(10_000n, 2_000n, 1000), { lowOre: 8_718n, highOre: 11_282n });
  assert.deepEqual(estimateRange(10_000n, 9_500n, 1000), { lowOre: 9_500n, highOre: 11_282n });
  assert.deepEqual(estimateRange(10_000n, 2_000n, 0), { lowOre: 10_000n, highOre: 10_000n });
});
