import test from 'node:test';
import assert from 'node:assert/strict';
import { operationNeedsReview, readyResolution } from './operationRecovery.js';

test('protected provisioning timeouts expose review actions rather than cleanup only', () => {
  assert.equal(operationNeedsReview({ type: 'provision', status: 'timeout' }), true);
  assert.equal(operationNeedsReview({ type: 'provision', status: 'needs_review' }), true);
  assert.equal(operationNeedsReview({ type: 'provision', status: 'ready' }), false);
  assert.equal(operationNeedsReview({ type: 'migration', status: 'timeout' }), false);
});

test('missing-task recovery requires explicit evidence while saved tasks keep their normal resolution', () => {
  assert.equal(readyResolution({ type: 'provision', upid: '' }), null);
  assert.equal(readyResolution({ type: 'provision', upid: '' }, 'short'), null);
  assert.equal(readyResolution({ type: 'provision', upid: '' }, 'x'.repeat(1001)), null);
  assert.deepEqual(readyResolution({ type: 'provision', upid: '' }, ' Verified VM disks and completion '), {
    status: 'ready', verified: true, evidence: 'Verified VM disks and completion',
  });
  assert.deepEqual(readyResolution({ type: 'provision', upid: 'UPID:test' }), { status: 'ready' });
  assert.deepEqual(readyResolution({ type: 'migration', upid: '' }), { status: 'ok' });
});
