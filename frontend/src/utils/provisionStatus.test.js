import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVISION_TERMINAL, PROVISION_FAILED } from './provisionStatus.js';

test('needs_review is terminal and counts as a failure', () => {
  assert.ok(PROVISION_TERMINAL.includes('needs_review'));
  assert.ok(PROVISION_FAILED.includes('needs_review'));
  assert.ok(!PROVISION_TERMINAL.includes('creating'));
});
