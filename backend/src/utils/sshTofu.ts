import { Client as SSHClient } from 'ssh2';
import { decryptSecret } from './secrets.ts';
import { sshHostFingerprint } from './sshHostKey.ts';

export function connectTofuSsh(target, recoveryHint = '') {
  return new Promise<{ conn: InstanceType<typeof SSHClient>; fingerprint: string }>((resolve, reject) => {
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
          hostKeyError = `SSH host key mismatch for ${target.ssh_host}: expected ${expected}, got ${fingerprint}.${recoveryHint ? ` ${recoveryHint}` : ''}`;
          return false;
        }
        return true;
      },
    });
  });
}

export function execTofuSsh(conn, command) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      stream.on('data', (d) => { output += d; });
      stream.stderr.on('data', (d) => { output += d; });
      stream.on('close', (code) => resolve({ code, output }));
    });
  });
}
