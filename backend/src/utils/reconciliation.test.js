import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpstreamTask } from './reconciliation.js';

test('restart reconciliation distinguishes running, success, and failure', () => {
  assert.equal(classifyUpstreamTask({ status: 'running' }).status, 'running');
  assert.equal(classifyUpstreamTask({ status: 'stopped', exitstatus: 'OK' }).status, 'needs_review');
  assert.equal(classifyUpstreamTask({ status: 'stopped', exitstatus: 'ERROR' }).status, 'error');
});
