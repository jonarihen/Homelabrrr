import test from 'node:test';
import assert from 'node:assert/strict';
import { sftpClientError } from './sftpError.ts';

test('SFTP errors expose stable messages without remote paths or hosts', () => {
  const missing = sftpClientError(new Error('ENOENT /home/private/secret.txt on vm.internal'));
  assert.deepEqual(missing, { status: 404, code: 'SFTP_PATH_NOT_FOUND', error: 'The remote path was not found' });
  assert.equal(JSON.stringify(missing).includes('/home/private'), false);

  const unknown = sftpClientError(new Error('library exploded at 10.20.30.40'));
  assert.deepEqual(unknown, { status: 500, code: 'SFTP_OPERATION_FAILED', error: 'The SFTP operation failed' });
});
