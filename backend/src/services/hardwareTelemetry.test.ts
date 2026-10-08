import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInstantaneousWatts } from './hardwareTelemetry.ts';

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
