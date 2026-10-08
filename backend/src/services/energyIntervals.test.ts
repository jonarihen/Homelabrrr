import test from 'node:test';
import assert from 'node:assert/strict';
import { integrateWattSamples, type WattSample } from './energyIntervals.ts';

const origin = Date.parse('2026-10-08T00:00:00Z');
function sample(minutes: number, watts: number, hardwareId = 1, epoch = 'a'): WattSample {
  return { hardwareId, observedAt: new Date(origin + minutes * 60_000), watts, deviceEpoch: epoch };
}

test('constant 250 W for four covered hours integrates to one kWh', () => {
  const readings = Array.from({ length: 241 }, (_, minute) => sample(minute, 250));
  const intervals = integrateWattSamples(readings);
  assert.equal(intervals.length, 16);
  assert.equal(intervals.reduce((sum, interval) => sum + Number(interval.kwh), 0), 1);
  assert.ok(intervals.every((interval) => interval.quality === 'integrated_complete'));
});

test('1000 W over 15 minutes is 0.25 kWh with uneven spacing', () => {
  const intervals = integrateWattSamples([sample(0, 1000), sample(2, 1000), sample(5, 1000), sample(8, 1000), sample(11, 1000), sample(15, 1000)], { maxGapMs: 5 * 60_000 });
  assert.equal(intervals[0].kwh, '0.250000000');
  assert.equal(intervals[0].coveredSeconds, 900);
});

test('long gaps stay unknown, real zero is covered, lone sample adds nothing', () => {
  assert.deepEqual(integrateWattSamples([sample(0, 200)]), []);
  assert.deepEqual(integrateWattSamples([sample(0, 200), sample(10, 200)]), []);
  const [zero] = integrateWattSamples([sample(0, 0), sample(1, 0)]);
  assert.equal(zero.kwh, '0.000000000');
  assert.equal(zero.quality, 'integrated_partial');
});

test('buckets conserve linearly changing power across boundaries', () => {
  const intervals = integrateWattSamples([sample(14, 0), sample(16, 1200)]);
  assert.equal(intervals.length, 2);
  assert.equal(Number(intervals[0].kwh) + Number(intervals[1].kwh), 0.02);
  assert.equal(intervals[0].coveredSeconds, 60);
  assert.equal(intervals[1].coveredSeconds, 60);
});

test('duplicate, out-of-order and separate device epoch do not double count', () => {
  const readings = [sample(2, 250), sample(0, 250), sample(1, 250), sample(1, 250), sample(3, 250, 1, 'b')];
  const intervals = integrateWattSamples(readings);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].coveredSeconds, 120);
  assert.deepEqual(integrateWattSamples(readings), intervals);
});

test('different physical systems are never bridged', () => {
  const intervals = integrateWattSamples([sample(0, 250), sample(1, 250), sample(0, 100, 2), sample(1, 100, 2)]);
  assert.equal(intervals.length, 2);
  assert.deepEqual(intervals.map((interval) => interval.hardwareId), [1, 2]);
});

test('invalid watts and timestamps are rejected instead of treated as zero', () => {
  assert.throws(() => integrateWattSamples([sample(0, NaN)]));
  assert.throws(() => integrateWattSamples([{ ...sample(0, 1), observedAt: new Date(NaN) }]));
  assert.throws(() => integrateWattSamples([sample(0, -1)]));
});
