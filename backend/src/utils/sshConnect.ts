import { Client as SSHClient } from 'ssh2';
import { normalizeSshHostFingerprint, sshHostFingerprint } from './sshHostKey.ts';
import { decryptSecret } from './secrets.ts';

/**
 * Create an authenticated SSH connection with host key verification.
 *
 * @param {{host:string, port:number, username:string, privateKey:string, passphrase?:string, hostFingerprint:string}} opts
 * @returns {Promise<import('ssh2').Client>}
 */
export function createSshConnection({ host, port, username, privateKey, passphrase, hostFingerprint }) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const expectedFingerprint = normalizeSshHostFingerprint(hostFingerprint);
    let hostVerificationError = '';

    conn.on('ready', () => resolve(conn));

    conn.on('error', (err) => {
      reject(new Error(hostVerificationError || err.message));
    });

    try {
      conn.connect({
        host,
        port,
        username,
        privateKey,
        passphrase: passphrase || undefined,
        readyTimeout: 10000,
        hostVerifier: (key) => {
          const presented = sshHostFingerprint(key);
          if (presented !== expectedFingerprint) {
            hostVerificationError = `SSH host key mismatch. Expected ${expectedFingerprint}, got ${presented}`;
            return false;
          }
          return true;
        },
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Connect to an infrastructure host (Caddy server / Proxmox node) whose SSH
 * settings are stored on its own row: ssh_host, ssh_user, ssh_secret
 * (encrypted), ssh_auth_type, ssh_host_key. Pins the host key on first use
 * and resolves the presented fingerprint so callers can persist it.
 */
export function connectSshHostPinned(target, mismatchAdvice) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const expected = target.ssh_host_key || '';
    let fingerprint = '';
    let hostKeyError = '';

    conn.on('ready', () => resolve({ conn, fingerprint }));
    conn.on('error', (err) => {
      reject(new Error(hostKeyError || `SSH connection to ${target.ssh_host} failed: ${err.message}`));
    });

    const secret = decryptSecret(target.ssh_secret);
    const auth = target.ssh_auth_type === 'password' ? { password: secret } : { privateKey: secret };
    conn.connect({
      host: target.ssh_host,
      port: target.ssh_port || 22,
      username: target.ssh_user,
      readyTimeout: 10000,
      ...auth,
      hostVerifier: (key) => {
        fingerprint = sshHostFingerprint(key);
        if (expected && fingerprint !== expected) {
          hostKeyError = `SSH host key mismatch for ${target.ssh_host}: expected ${expected}, got ${fingerprint}. ${mismatchAdvice}`;
          return false;
        }
        return true;
      },
    });
  });
}
