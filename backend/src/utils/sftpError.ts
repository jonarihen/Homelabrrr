import { sshClientError } from './sshError.ts';

export function sftpClientError(err) {
  const message = String(err?.message || err || '');
  if (/permission denied|access denied|failure.*permission/i.test(message)) {
    return { status: 403, code: 'SFTP_PERMISSION_DENIED', error: 'The remote server denied this file operation' };
  }
  if (/no such file|not found|ENOENT/i.test(message)) {
    return { status: 404, code: 'SFTP_PATH_NOT_FOUND', error: 'The remote path was not found' };
  }
  if (/already exists|EEXIST/i.test(message)) {
    return { status: 409, code: 'SFTP_PATH_EXISTS', error: 'The remote path already exists' };
  }
  if (/not a directory|ENOTDIR/i.test(message)) {
    return { status: 400, code: 'SFTP_NOT_A_DIRECTORY', error: 'The selected remote path is not a directory' };
  }
  const ssh = sshClientError(err);
  if (ssh.code !== 'SSH_CONNECTION_FAILED') return { status: 502, ...ssh };
  return { status: 500, code: 'SFTP_OPERATION_FAILED', error: 'The SFTP operation failed' };
}
