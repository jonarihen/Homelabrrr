export interface SftpSession {
  userId: number;
  sessionId: string;
  node: string;
  vmid: number | string;
  host: string;
  port: number;
  username: string;
  hostFingerprint: string;
  privateKey: string;
  passphrase: string;
  expires: number;
  absoluteExpires: number;
}

export const sftpSessions = new Map<string, SftpSession>();

export function revokeSftpSession(sessionId: string): void {
  for (const [token, sess] of sftpSessions) {
    if (sess.sessionId === sessionId) sftpSessions.delete(token);
  }
}

export function revokeUserSftpSessions(userId: number): void {
  for (const [token, sess] of sftpSessions) {
    if (sess.userId === userId) sftpSessions.delete(token);
  }
}
