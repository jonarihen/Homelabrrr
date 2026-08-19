import { Client as SSHClient } from 'ssh2';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { pveHosts } from '../db/schema/index.ts';
import { decryptSecret } from './secrets.ts';
import { sshHostFingerprint } from './sshHostKey.ts';

// Root SSH to a Proxmox node. Used ONLY for the one hypervisor task the PVE
// API cannot express: forgetting a VM config without destroying its disks
// (after a shared-storage migration the leftover source config references the
// same volumes the migrated VM uses — qm destroy would erase them). The host
// key is pinned on first use into pve_hosts.ssh_host_key; a later mismatch
// aborts the connection.

export function hostHasSsh(host) {
  return !!(host?.ssh_host && host?.ssh_user && host?.ssh_secret);
}

function connectSsh(host) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const expected = host.ssh_host_key || '';
    let fingerprint = '';
    let hostKeyError = '';
    conn.on('ready', () => resolve({ conn, fingerprint }));
    conn.on('error', (err) => {
      reject(new Error(hostKeyError || `SSH connection to ${host.ssh_host} failed: ${err.message}`));
    });
    const secret = decryptSecret(host.ssh_secret);
    const auth = host.ssh_auth_type === 'password' ? { password: secret } : { privateKey: secret };
    conn.connect({
      host: host.ssh_host,
      port: host.ssh_port || 22,
      username: host.ssh_user,
      readyTimeout: 10000,
      ...auth,
      hostVerifier: (key) => {
        fingerprint = sshHostFingerprint(key);
        if (expected && fingerprint !== expected) {
          hostKeyError = `SSH host key mismatch for ${host.ssh_host}: expected ${expected}, got ${fingerprint}. If the node was reinstalled, clear the pinned key by re-saving its SSH settings.`;
          return false;
        }
        return true; // first connect: trust-on-first-use, pinned below
      },
    });
  });
}

function execSsh(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      stream.on('data', (d) => { output += d; });
      stream.stderr.on('data', (d) => { output += d; });
      stream.on('close', (code) => resolve({ code, output: output.trim() }));
    });
  });
}

// Run shell commands on the node; returns [{ code, output }] in order, stopping
// at the first failing command. Pins the host key on first successful connect.
export async function runNodeCommands(host, commands) {
  const { conn, fingerprint } = await connectSsh(host);
  try {
    if (!host.ssh_host_key && fingerprint) {
      await db.update(pveHosts).set({ ssh_host_key: fingerprint }).where(eq(pveHosts.id, host.id));
    }
    const results = [];
    for (const command of commands) {
      const result = await execSsh(conn, command);
      results.push(result);
      if (result.code !== 0) break;
    }
    return results;
  } finally {
    conn.end();
  }
}
