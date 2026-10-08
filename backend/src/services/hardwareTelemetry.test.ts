import test from 'node:test';
import assert from 'node:assert/strict';
// Pure helpers do not connect, but importing the collector initializes the DB client.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const { aggregationLookbackStart, aggregationLookaheadEnd, validateInstantaneousWatts } = await import('./hardwareTelemetry.ts');

test('recomputation includes the full previous quarter-hour bucket', () => {
  assert.equal(aggregationLookbackStart(new Date('2026-10-08T15:31:00Z')).toISOString(), '2026-10-08T15:15:00.000Z');
  assert.equal(aggregationLookbackStart(new Date('2026-10-08T15:00:00Z')).toISOString(), '2026-10-08T14:45:00.000Z');
});

test('late observations recompute later affected intervals', () => {
  assert.equal(aggregationLookaheadEnd(new Date('2026-10-08T15:14:00Z')).toISOString(), '2026-10-08T15:30:00.000Z');
  assert.equal(aggregationLookaheadEnd(new Date('2026-10-08T15:15:00Z')).toISOString(), '2026-10-08T15:45:00.000Z');
});

const now = new Date('2026-10-08T15:00:00Z');
test('real zero and standby draw remain measurements', () => {
  assert.equal(validateInstantaneousWatts(0, now.toISOString(), now).watts, 0);
  assert.equal(validateInstantaneousWatts(18, now.toISOString(), now).watts, 18);
});
test('missing, malformed, implausible and stale observations are rejected', () => {
  for (const watts of [null, undefined, NaN, Infinity, -1, 100001]) assert.throws(() => validateInstantaneousWatts(watts, now.toISOString(), now));
  assert.throws(() => validateInstantaneousWatts(50, 'bad-time', now));
  assert.throws(() => validateInstantaneousWatts(50, '2026-10-08T14:57:00Z', now));
  assert.throws(() => validateInstantaneousWatts(50, '2026-10-08T15:01:00Z', now));
});
