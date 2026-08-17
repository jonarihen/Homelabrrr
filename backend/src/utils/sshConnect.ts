import { Client as SSHClient } from 'ssh2';
import { normalizeSshHostFingerprint, sshHostFingerprint } from './sshHostKey.ts';

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
