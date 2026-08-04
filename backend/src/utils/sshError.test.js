import test from 'node:test';
import assert from 'node:assert/strict';
import { sshClientError } from './sshError.js';

test('SSH errors are stable and do not expose fingerprints or hosts', () => {
  const payload = sshClientError(new Error('Expected SHA256:secret, got SHA256:other at 10.0.0.2'));
  assert.equal(payload.code, 'SSH_HOST_KEY_MISMATCH');
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.equal(JSON.stringify(payload).includes('10.0.0.2'), false);
});
