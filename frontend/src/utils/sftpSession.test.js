import test from 'node:test';
import assert from 'node:assert/strict';
import { SFTP_SESSION_EXPIRED, isSftpSessionExpired } from './sftpSession.js';

test('only the expired-token payload counts as an expired SFTP session', () => {
  assert.equal(isSftpSessionExpired({ response: { status: 403, data: { code: SFTP_SESSION_EXPIRED } } }), true);
  for (const err of [
    { response: { status: 401, data: { error: 'Unauthorized' } } },
    { response: { status: 403, data: { error: 'Access denied' } } },
    { response: { status: 403, data: { code: 'CONFIRMATION_FAILED' } } },
    { response: { status: 500, data: { code: SFTP_SESSION_EXPIRED } } },
    new Error('Network Error'),
    null,
    undefined,
  ]) {
    assert.equal(isSftpSessionExpired(err), false, JSON.stringify(err?.response ?? err));
  }
});
