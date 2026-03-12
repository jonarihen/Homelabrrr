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

    conn.on('ready', () => {
      if (fingerprint) finish(null, fingerprint);
      else finish(new Error('SSH host key scan finished without a fingerprint'));
    });

    conn.on('error', (err) => {
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
        username: '__fingerprint_scan__',
        password: '__fingerprint_scan__',
        readyTimeout: 10000,
        hostVerifier: (key) => {
          fingerprint = sshHostFingerprint(key);
          return true;
        },
      });
    } catch (err) {
      finish(err);
    }
  });
}
