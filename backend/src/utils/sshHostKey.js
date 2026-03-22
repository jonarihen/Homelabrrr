import { createHash } from 'crypto';
import { Client as SSHClient } from 'ssh2';

export function sshHostFingerprint(rawKey) {
  return `SHA256:${createHash('sha256').update(rawKey).digest('base64')}`;
}

export function normalizeSshHostFingerprint(value = '') {
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  return trimmed.startsWith('SHA256:') ? trimmed : `SHA256:${trimmed}`;
}

/**
 * Scan an SSH server's host key fingerprint without authenticating.
 * Rejects the host key immediately after capturing it so no auth is attempted.
 */
export function scanSshHostFingerprint(host, port = 22) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let fingerprint = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };

    conn.on('error', (err) => {
      // If we already captured the fingerprint, the error is expected
      // (host key rejected) — resolve with the fingerprint.
      if (fingerprint) finish(null, fingerprint);
      else finish(new Error(`SSH host key scan failed: ${err.message}`));
    });

    conn.on('close', () => {
      if (fingerprint) finish(null, fingerprint);
      else finish(new Error('SSH host key scan failed before a fingerprint was received'));
    });

    try {
      conn.connect({
        host,
        port,
        username: 'none',
        readyTimeout: 10000,
        hostVerifier: (key) => {
          fingerprint = sshHostFingerprint(key);
          // Reject the host key so ssh2 disconnects before authenticating.
          // This prevents any auth attempt from appearing in the server's logs.
          return false;
        },
      });
    } catch (err) {
      finish(err);
    }
  });
}
