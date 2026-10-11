// Server process timezone must not influence schedule evaluation: instants
// are resolved through the schedule's IANA zone only. Node re-reads TZ when
// it changes, so the same assertions run under several host zones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleBoundaryInstants, scheduledModeAt, weekdayPreset } from './powerPolicy.ts';

const original = process.env.TZ;
test.after(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; });

for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Chatham']) {
  test(`weekly preset is independent of server TZ=${zone}`, () => {
    process.env.TZ = zone;
    const schedule = weekdayPreset(); schedule.enabled = true;
    assert.equal(scheduledModeAt(schedule, new Date('2026-10-12T13:59:00Z')), 'low');
    assert.equal(scheduledModeAt(schedule, new Date('2026-10-12T14:00:00Z')), 'high');
    assert.equal(scheduledModeAt(schedule, new Date('2026-10-17T09:59:00Z')), 'low');
    assert.equal(scheduledModeAt(schedule, new Date('2026-10-18T19:59:00Z')), 'high');
    // Copenhagen autumn change: Sunday 22:00 CET is 21:00Z after clocks go back.
    assert.equal(scheduledModeAt(schedule, new Date('2026-10-25T20:59:00Z')), 'high');
    assert.equal(scheduledModeAt(schedule, new Date('2026-10-25T21:00:00Z')), 'low');
    const boundaries = scheduleBoundaryInstants(schedule, new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T12:00:00Z'));
    assert.deepEqual(boundaries.map((value) => value.toISOString()), ['2026-10-12T14:00:00.000Z', '2026-10-13T00:00:00.000Z']);
  });
}
