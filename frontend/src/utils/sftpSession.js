export const SFTP_SESSION_EXPIRED = 'SFTP_SESSION_EXPIRED';

export function isSftpSessionExpired(err) {
  return [401, 403, 409, 410].includes(err?.response?.status)
    && err?.response?.data?.code === SFTP_SESSION_EXPIRED;
}
