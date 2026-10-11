import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDkkPerKwh, resolvePowerDecision, scheduledModeAt, validatePowerSchedule,
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
