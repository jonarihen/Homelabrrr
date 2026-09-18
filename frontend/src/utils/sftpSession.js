export const SFTP_SESSION_EXPIRED = 'SFTP_SESSION_EXPIRED';

export function isSftpSessionExpired(err) {
  return err?.response?.status === 403 && err?.response?.data?.code === SFTP_SESSION_EXPIRED;
}
