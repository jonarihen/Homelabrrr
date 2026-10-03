import test from 'node:test';
import assert from 'node:assert/strict';
import { backupVerificationLabel } from './backupVerification.js';

test('only a full restore timestamp earns a full restore verified label', () => {
  assert.equal(backupVerificationLabel({ status: 'verified', full_restore_verified_at: '2026-10-03T00:00:00Z' }), 'Full restore verified');
  assert.equal(backupVerificationLabel({ status: 'verified', verified_at: '2026-10-02T00:00:00Z' }), 'TOC checked only');
  assert.equal(backupVerificationLabel({ status: 'toc_checked' }), 'TOC checked only');
  assert.equal(backupVerificationLabel({ status: 'error' }), 'error');
  assert.equal(backupVerificationLabel({ status: 'running' }), 'running');
  assert.equal(backupVerificationLabel(null), 'No backup run recorded');
});
