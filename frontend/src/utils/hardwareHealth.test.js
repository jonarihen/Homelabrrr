import test from 'node:test';
import assert from 'node:assert/strict';
import { healthAvailability, formatTemperature, formatFan } from './hardwareHealth.js';

test('missing, unsupported and stale health never appear as zero readings', () => {
  assert.equal(healthAvailability(null, 'supported', []), 'No observation');
  assert.equal(healthAvailability({ stale: true }, 'supported', [{ celsius: 0 }]), 'Stale observation');
  assert.equal(healthAvailability({ stale: false }, 'unsupported', []), 'Unsupported');
  assert.equal(healthAvailability({ stale: false }, 'unavailable', []), 'Temporarily unavailable');
  assert.equal(healthAvailability({ stale: false }, 'supported', [{ celsius: null }]), 'Partial readings');
  assert.equal(formatTemperature({ celsius: null }), 'Reading unavailable');
  assert.equal(formatFan({ value: null, unit: 'percent' }), 'Reading unavailable');
  assert.equal(formatFan({ value: 0, unit: 'percent' }), '0%');
});
