import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManualExpiry } from './manualPowerOverride.ts';
import { weekdayPreset } from './powerPolicy.ts';

test('manual duration defaults to three hours and only explicit until-cleared is indefinite', () => {
  const schedule = weekdayPreset();
  const now = new Date('2026-10-12T12:00:00Z');
  assert.equal(resolveManualExpiry({}, schedule, now)?.toISOString(), '2026-10-12T15:00:00.000Z');
  assert.equal(resolveManualExpiry({ durationKind: 'minutes', durationMinutes: 15 }, schedule, now)?.toISOString(), '2026-10-12T12:15:00.000Z');
  assert.equal(resolveManualExpiry({ durationKind: 'until_cleared' }, schedule, now), null);
  assert.equal(resolveManualExpiry({ untilCleared: true }, schedule, now), null);
  assert.throws(() => resolveManualExpiry({ durationKind: 'until_cleared', durationMinutes: 180 }, schedule, now));
  assert.throws(() => resolveManualExpiry({ durationKind: 'until_cleared', untilCleared: false }, schedule, now));
  assert.throws(() => resolveManualExpiry({ durationKind: 'next_schedule_boundary', untilCleared: true }, schedule, now));
});

test('next weekly boundary is strict and follows the start-day overnight preset', () => {
  const schedule = weekdayPreset(); schedule.enabled = true;
  assert.equal(resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule,
    new Date('2026-10-12T13:59:00Z'))?.toISOString(), '2026-10-12T14:00:00.000Z');
  assert.equal(resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule,
    new Date('2026-10-12T14:00:00Z'))?.toISOString(), '2026-10-13T00:00:00.000Z');
  assert.equal(resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule,
    new Date('2026-10-16T14:01:00Z'))?.toISOString(), '2026-10-17T00:00:00.000Z');
  assert.equal(resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule,
    new Date('2026-10-18T20:01:00Z'))?.toISOString(), '2026-10-19T14:00:00.000Z');
});

test('next-boundary expiry uses the documented DST gap and repeated-hour policy', () => {
  const schedule = weekdayPreset(); schedule.enabled = true;
  schedule.windows = [{ days: 1, start: '02:30', end: '04:00', mode: 'high' }];
  assert.equal(resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule,
    new Date('2026-03-29T00:59:00Z'))?.toISOString(), '2026-03-29T01:00:00.000Z');
  schedule.windows = [{ days: 1, start: '02:30', end: '03:00', mode: 'high' }];
  assert.equal(resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule,
    new Date('2026-10-25T00:29:00Z'))?.toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule,
    new Date('2026-10-25T00:30:00Z'))?.toISOString(), '2026-10-25T02:00:00.000Z');
});

test('next-boundary override requires an enabled schedule with an actual boundary', () => {
  const schedule = weekdayPreset();
  assert.throws(() => resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule, new Date()), /Enable a weekly schedule/);
  schedule.enabled = true; schedule.windows = [];
  assert.throws(() => resolveManualExpiry({ durationKind: 'next_schedule_boundary' }, schedule, new Date()), /No next weekly/);
});
