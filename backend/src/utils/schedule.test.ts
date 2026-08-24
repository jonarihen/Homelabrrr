// Regression coverage for the vm_schedules row → API shaping helpers.
// Run with:  node --test src/utils/schedule.test.ts   (from backend/)
//
// The PostgreSQL migration turned vm_schedules.enabled and
// .running_due_to_manual into real booleans while these helpers still compared
// them against 1, so every schedule reported itself disabled. The round-trip
// test below is the one that pins the contract: it takes the row shape Drizzle
// actually returns rather than a hand-built fixture, which is what let the
// regression through in the first place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { vmSchedules } from '../db/schema/index.ts';
import { serializeSchedule, scheduleBadge, ALL_DAYS } from './schedule.ts';

const row = (overrides = {}) => ({
  id: 1,
  node: '1~pve',
  vmid: 101,
  enabled: true,
  stop_time: '23:00',
  start_time: '08:00',
  days: ALL_DAYS,
  timezone: 'UTC',
  skip_until: 0,
  running_due_to_manual: false,
  stopped_this_window: false,
  last_off: -1,
  last_action: '',
  last_action_at: 0,
  ...overrides,
});

// ─── serializeSchedule ───────────────────────────────────────────────────────

test('an enabled schedule serializes as enabled', () => {
  const out = serializeSchedule(row());
  assert.equal(out.enabled, true);
  assert.equal(out.stopTime, '23:00');
  assert.equal(out.startTime, '08:00');
  assert.equal(out.days, ALL_DAYS);
  assert.equal(out.timezone, 'UTC');
});

test('a disabled schedule serializes as disabled', () => {
  assert.equal(serializeSchedule(row({ enabled: false })).enabled, false);
});

test('enabled is always a real boolean, never the raw column value', () => {
  for (const value of [true, false, null, undefined]) {
    assert.equal(typeof serializeSchedule(row({ enabled: value })).enabled, 'boolean');
  }
  // A null flag means "not set", which is not enabled — the same verdict the
  // pre-migration `=== 1` comparison reached.
  assert.equal(serializeSchedule(row({ enabled: null })).enabled, false);
});

test('runningDueToManual reflects the boolean column', () => {
  assert.equal(serializeSchedule(row({ running_due_to_manual: true })).runningDueToManual, true);
  assert.equal(serializeSchedule(row({ running_due_to_manual: false })).runningDueToManual, false);
  assert.equal(typeof serializeSchedule(row({ running_due_to_manual: null })).runningDueToManual, 'boolean');
});

test('skipActive is derived from skip_until against the supplied clock', () => {
  const now = 1_700_000_000_000;
  assert.equal(serializeSchedule(row({ skip_until: now + 60_000 }), now).skipActive, true);
  assert.equal(serializeSchedule(row({ skip_until: now - 60_000 }), now).skipActive, false);
  assert.equal(serializeSchedule(row({ skip_until: 0 }), now).skipActive, false);
});

test('a missing row serializes to null', () => {
  assert.equal(serializeSchedule(null), null);
});

// ─── scheduleBadge ───────────────────────────────────────────────────────────

test('an enabled schedule produces a dashboard badge', () => {
  const badge = scheduleBadge(row());
  assert.ok(badge, 'an enabled schedule must produce a badge');
  assert.equal(badge.enabled, true);
  assert.equal(badge.stopTime, '23:00');
  assert.equal(badge.startTime, '08:00');
});

test('no badge for a disabled schedule, a missing row, or half-configured times', () => {
  assert.equal(scheduleBadge(null), null);
  assert.equal(scheduleBadge(row({ enabled: false })), null);
  assert.equal(scheduleBadge(row({ enabled: null })), null);
  assert.equal(scheduleBadge(row({ stop_time: '' })), null);
  assert.equal(scheduleBadge(row({ start_time: '' })), null);
});

// ─── The row shape Drizzle actually returns ──────────────────────────────────

test('a schedule round-tripped through PostgreSQL serializes as enabled', async () => {
  const t = await createTestDatabase();
  try {
    await t.db.insert(vmSchedules).values({
      node: '1~pve',
      vmid: 101,
      enabled: true,
      stop_time: '23:00',
      start_time: '08:00',
      days: ALL_DAYS,
      timezone: 'UTC',
      running_due_to_manual: true,
    });
    const [stored] = await t.db.select().from(vmSchedules).where(eq(vmSchedules.vmid, 101)).limit(1);

    // The column really is a boolean — if this ever changes, the helpers below
    // are the things that need revisiting.
    assert.equal(typeof stored.enabled, 'boolean');
    assert.equal(stored.enabled, true);

    const out = serializeSchedule(stored);
    assert.equal(out.enabled, true, 'the API must report a stored-enabled schedule as enabled');
    assert.equal(out.runningDueToManual, true);
    assert.ok(scheduleBadge(stored), 'a stored-enabled schedule must produce a badge');
  } finally {
    await t.drop();
  }
});
