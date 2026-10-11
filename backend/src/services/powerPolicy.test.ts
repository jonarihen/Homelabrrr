import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDkkPerKwh, parseDkkPerKwh, resolvePowerDecision, scheduledModeAt, validatePowerSchedule,
  validatePricePolicy, weekdayPreset,
  type PowerDecisionInput, type PowerPricePolicy,
} from './powerPolicy.ts';

function at(localIso: string): Date { return new Date(localIso); }

const policy: PowerPricePolicy = {
  enabled: true,
  basis: 'variable_retail_including_vat',
  contractRef: 'contract-1',
  area: 'DK2',
  expensive: { enabled: true, threshold: '3.00', hysteresis: '0.10', capMode: 'dynamic' },
  cheap: { enabled: true, threshold: '1.00', hysteresis: '0.10' },
  version: 1,
};

function input(now = at('2026-10-12T16:00:00Z')): PowerDecisionInput {
  const schedule = weekdayPreset();
  schedule.enabled = true;
  return {
    now, schedule, pricePolicy: structuredClone(policy), controlEnabled: true,
    automationPaused: false, driftHold: false, actualMode: 'low',
    supportedModes: ['low', 'dynamic', 'high'],
    price: {
      dkk_per_kwh: '2.00', basis: policy.basis, contract_ref: 'contract-1', area: 'DK2',
      start_utc: '2026-10-12T16:00:00Z', end_utc: '2026-10-12T17:00:00Z',
      status: 'valid', contract_revision: '1', source_revision: 'a',
    },
  };
}

test('weekday preset owns overnight windows by start day', () => {
  const schedule = weekdayPreset();
  validatePowerSchedule(schedule);
  assert.equal(scheduledModeAt(schedule, at('2026-10-12T13:59:00Z')), 'low'); // Monday 15:59 CEST
  assert.equal(scheduledModeAt(schedule, at('2026-10-12T14:00:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-10-12T23:59:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-10-13T00:00:00Z')), 'low');
  assert.equal(scheduledModeAt(schedule, at('2026-10-17T00:00:00Z')), 'low'); // Saturday 02:00 CEST
  assert.equal(scheduledModeAt(schedule, at('2026-10-17T10:00:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-10-18T20:00:00Z')), 'low');
});

test('Copenhagen spring gap and repeated autumn hour follow wall-clock schedule', () => {
  const schedule = weekdayPreset();
  schedule.windows = [{ days: 1, start: '01:30', end: '04:00', mode: 'high' }];
  assert.equal(scheduledModeAt(schedule, at('2026-03-29T00:29:00Z')), 'low');
  assert.equal(scheduledModeAt(schedule, at('2026-03-29T00:30:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-03-29T01:30:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-03-29T01:31:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-03-29T02:00:00Z')), 'low');
  schedule.windows = [{ days: 1, start: '02:00', end: '03:00', mode: 'high' }];
  assert.equal(scheduledModeAt(schedule, at('2026-10-25T00:30:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-10-25T01:30:00Z')), 'high');
  assert.equal(scheduledModeAt(schedule, at('2026-10-25T02:00:00Z')), 'low');
});

test('window overlap includes overnight Sunday to Monday', () => {
  const schedule = weekdayPreset();
  schedule.windows = [
    { days: 1, start: '23:00', end: '03:00', mode: 'high' },
    { days: 2, start: '02:00', end: '04:00', mode: 'dynamic' },
  ];
  assert.throws(() => validatePowerSchedule(schedule), /Overlapping/);
});

test('DKK decimal comparison is exact and accepts Danish input', () => {
  assert.equal(parseDkkPerKwh('3,000001'), 3_000_001n);
  assert.equal(parseDkkPerKwh('-0,25'), -250_000n);
  assert.throws(() => parseDkkPerKwh('3.1234567'));
});

test('expensive cap never raises low and cheap boost raises low', () => {
  const high = input();
  high.price!.dkk_per_kwh = '3.50';
  assert.deepEqual([resolvePowerDecision(high).target, resolvePowerDecision(high).reason], ['dynamic', 'price_high']);
  high.pricePolicy.expensive.capMode = 'low';
  assert.equal(resolvePowerDecision(high).target, 'low');
  high.schedule.enabled = false;
  high.pricePolicy.priceOnlyDefault = 'low';
  high.pricePolicy.expensive.capMode = 'dynamic';
  assert.equal(resolvePowerDecision(high).target, 'low');
  high.price!.dkk_per_kwh = '0.75';
  assert.deepEqual([resolvePowerDecision(high).target, resolvePowerDecision(high).reason], ['high', 'price_low']);
});

test('hysteresis and exact equality are stable across published intervals', () => {
  const x = input();
  x.price!.dkk_per_kwh = '3.00';
  assert.equal(resolvePowerDecision(x).latch.expensive, false);
  x.price!.dkk_per_kwh = '3.01';
  const active = resolvePowerDecision(x);
  assert.equal(active.latch.expensive, true);
  x.previousLatch = active.latch;
  x.price!.dkk_per_kwh = '2.95';
  assert.equal(resolvePowerDecision(x).latch.expensive, true);
  x.price!.dkk_per_kwh = '2.90';
  assert.equal(resolvePowerDecision(x).latch.expensive, false);
  x.price!.dkk_per_kwh = '1.00';
  x.previousLatch = null;
  assert.equal(resolvePowerDecision(x).latch.cheap, false);
});

test('manual, pause, unsupported and expired price fail safely', () => {
  const x = input();
  x.price!.dkk_per_kwh = '3.50';
  x.manualOverride = { mode: 'high', expiresAt: new Date(x.now.getTime() + 60_000) };
  assert.equal(resolvePowerDecision(x).reason, 'manual');
  x.automationPaused = true;
  assert.equal(resolvePowerDecision(x).target, null);
  x.automationPaused = false;
  x.manualOverride.expiresAt = x.now;
  assert.equal(resolvePowerDecision(x).target, 'dynamic');
  x.price!.end_utc = x.now.toISOString();
  assert.equal(resolvePowerDecision(x).reason, 'price_unavailable_fallback');
  x.actualMode = 'os_control';
  assert.equal(resolvePowerDecision(x).target, null);
});

test('mismatched basis and incomplete prices cannot trigger High', () => {
  const x = input();
  x.price!.dkk_per_kwh = '-1.00';
  x.price!.basis = 'spot_only_excluding_retail_additions';
  assert.equal(resolvePowerDecision(x).priceStatus, 'unavailable');
  x.price!.basis = policy.basis;
  x.price!.status = 'forecast';
  assert.equal(resolvePowerDecision(x).target, 'high'); // weekly baseline at this instant
  assert.equal(resolvePowerDecision(x).reason, 'price_unavailable_fallback');
});

test('15-minute price interval ends exclusively and clears a prior cheap latch', () => {
  const x = input(at('2026-10-12T16:14:59Z'));
  x.price!.start_utc = '2026-10-12T16:00:00Z';
  x.price!.end_utc = '2026-10-12T16:15:00Z';
  x.price!.dkk_per_kwh = '0.75';
  const cheap = resolvePowerDecision(x);
  assert.equal(cheap.reason, 'price_low');
  x.previousLatch = cheap.latch;
  x.now = at('2026-10-12T16:15:00Z');
  const expired = resolvePowerDecision(x);
  assert.equal(expired.reason, 'price_unavailable_fallback');
  assert.equal(expired.latch.cheap, false);
});

test('overlapping release bands are invalid', () => {
  const invalid = structuredClone(policy);
  invalid.cheap.threshold = '2.95';
  assert.throws(() => validatePricePolicy(invalid), /overlap/);
});

test('one enabled price rule does not parse the disabled rule blank threshold', () => {
  const x = input();
  x.pricePolicy.cheap = { enabled: false, threshold: '', hysteresis: '' };
  x.price!.dkk_per_kwh = '3.50';
  assert.equal(resolvePowerDecision(x).reason, 'price_high');
  x.pricePolicy.expensive = { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' };
  x.pricePolicy.cheap = { enabled: true, threshold: '1.00', hysteresis: '0.10' };
  x.price!.dkk_per_kwh = '0.50';
  assert.equal(resolvePowerDecision(x).reason, 'price_low');
});

test('exact weekend and Friday rollover boundaries', () => {
  const schedule = weekdayPreset();
  const cases: Array<[string, string]> = [
    ['2026-10-16T21:59:00Z', 'high'], // Friday 23:59 CEST, inside Friday's window
    ['2026-10-16T23:59:00Z', 'high'], // Saturday 01:59 owned by Friday
    ['2026-10-17T00:00:00Z', 'low'],  // Saturday 02:00
    ['2026-10-17T09:59:00Z', 'low'],  // Saturday 11:59
    ['2026-10-17T10:00:00Z', 'high'], // Saturday 12:00
    ['2026-10-18T19:59:00Z', 'high'], // Sunday 21:59
    ['2026-10-18T20:00:00Z', 'low'],  // Sunday 22:00 through Monday 16:00
    ['2026-10-19T13:59:00Z', 'low'],  // Monday 15:59
    ['2026-10-19T14:00:00Z', 'high'], // Monday 16:00
  ];
  for (const [instant, expected] of cases) assert.equal(scheduledModeAt(schedule, at(instant)), expected, instant);
});

test('cheap release exactly at L + hL, negative price boost and between-band baseline', () => {
  const x = input(at('2026-10-12T08:00:00Z')); // Monday 10:00: scheduled Low
  x.price!.start_utc = '2026-10-12T08:00:00Z'; x.price!.end_utc = '2026-10-12T08:15:00Z';
  x.price!.dkk_per_kwh = '-0,50';
  const boost = resolvePowerDecision(x);
  assert.deepEqual([boost.target, boost.reason, boost.baseMode], ['high', 'price_low', 'low']);
  x.previousLatch = boost.latch;
  x.price!.dkk_per_kwh = '1.09';
  assert.equal(resolvePowerDecision(x).latch.cheap, true, 'inside the release band the boost holds');
  x.price!.dkk_per_kwh = '1.10';
  const released = resolvePowerDecision(x);
  assert.equal(released.latch.cheap, false, 'p >= L + hL releases');
  assert.deepEqual([released.target, released.reason], ['low', 'schedule']);
  x.previousLatch = null;
  x.price!.dkk_per_kwh = '1.00';
  assert.equal(resolvePowerDecision(x).reason, 'schedule', 'equality with L does not newly activate');
  x.price!.dkk_per_kwh = '2.00';
  assert.deepEqual([resolvePowerDecision(x).target, resolvePowerDecision(x).reason], ['low', 'schedule']);
});

test('pause, drift hold and manual override carry the latch for the same policy version only', () => {
  const x = input();
  x.previousLatch = { expensive: true, cheap: false, policyVersion: 1, priceRevision: '1/a' };
  for (const key of ['automationPaused', 'driftHold'] as const) {
    const y = structuredClone(x); y[key] = true;
    assert.deepEqual(resolvePowerDecision(y).latch, x.previousLatch, key);
  }
  const manual = structuredClone(x);
  manual.manualOverride = { mode: 'high', expiresAt: null };
  assert.equal(resolvePowerDecision(manual).latch.expensive, true);
  const changed = structuredClone(x); changed.automationPaused = true; changed.pricePolicy.version = 2;
  assert.equal(resolvePowerDecision(changed).latch.expensive, false, 'a new policy version resets obsolete state');
});

test('corrupt stored policy is flagged and resolves restrictively without throwing', () => {
  const x = input();
  x.actualMode = 'high';
  (x.pricePolicy.cheap as any).threshold = '2.95'; // overlapping bands
  const restricted = resolvePowerDecision(x);
  assert.equal(restricted.reason, 'policy_invalid');
  assert.match(restricted.policyError ?? '', /overlap/);
  assert.equal(restricted.target, 'dynamic', 'capped at the expensive cap mode, never boosted');
  x.actualMode = 'low';
  assert.equal(resolvePowerDecision(x).target, null, 'never moves above the actual mode');
  const brokenSchedule = input();
  (brokenSchedule.schedule as any).windows = 'not-an-array';
  const hold = resolvePowerDecision(brokenSchedule);
  assert.deepEqual([hold.target, hold.reason], [null, 'policy_invalid']);
});

test('validators require strict booleans and own-property modes', () => {
  const schedule = weekdayPreset();
  assert.throws(() => validatePowerSchedule({ ...schedule, enabled: 'true' as any }), /Invalid power schedule/);
  assert.throws(() => validatePowerSchedule({ ...schedule, defaultMode: 'toString' as any }), /Invalid default mode/);
  const price = structuredClone(policy);
  (price.cheap as any).enabled = 1;
  assert.throws(() => validatePricePolicy(price), /Invalid price policy/);
  assert.equal(normalizeDkkPerKwh('1,250'), '1.25');
  assert.equal(normalizeDkkPerKwh('-0,000001'), '-0.000001');
  assert.equal(normalizeDkkPerKwh('3'), '3');
  assert.equal(normalizeDkkPerKwh('-0'), '0');
});
