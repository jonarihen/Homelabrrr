import test from 'node:test';
import assert from 'node:assert/strict';
import { manualPowerDurationRequest } from './manualPowerDuration.js';

test('manual power duration request sends only the selected duration fields', () => {
  assert.deepEqual(manualPowerDurationRequest('high', 'minutes', 180),
    { mode: 'high', durationKind: 'minutes', durationMinutes: 180 });
  assert.deepEqual(manualPowerDurationRequest('dynamic', 'next_schedule_boundary', 180),
    { mode: 'dynamic', durationKind: 'next_schedule_boundary' });
  assert.deepEqual(manualPowerDurationRequest('low', 'until_cleared', 180),
    { mode: 'low', durationKind: 'until_cleared' });
  assert.throws(() => manualPowerDurationRequest('low', 'unknown', 180));
});
