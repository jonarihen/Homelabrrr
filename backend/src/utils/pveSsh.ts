import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { pveHosts } from '../db/schema/index.ts';
import { connectTofuSsh, execTofuSsh } from './sshTofu.ts';

// Root SSH to a Proxmox node. Used ONLY for the one hypervisor task the PVE
// API cannot express: forgetting a VM config without destroying its disks
// (after a shared-storage migration the leftover source config references the
// same volumes the migrated VM uses — qm destroy would erase them). The host
// key is pinned on first use into pve_hosts.ssh_host_key; a later mismatch
// aborts the connection.

export function hostHasSsh(host) {
  return !!(host?.ssh_host && host?.ssh_user && host?.ssh_secret);
}

const HOST_KEY_HINT = 'If the node was reinstalled, clear the pinned key by re-saving its SSH settings.';

// Run shell commands on the node; returns [{ code, output }] in order, stopping
// at the first failing command. Pins the host key on first successful connect.
export async function runNodeCommands(host, commands) {
  const { conn, fingerprint } = await connectTofuSsh(host, HOST_KEY_HINT);
  try {
    if (!host.ssh_host_key && fingerprint) {
      await db.update(pveHosts).set({ ssh_host_key: fingerprint }).where(eq(pveHosts.id, host.id));
    }
    const results = [];
    for (const command of commands) {
      const { code, output } = await execTofuSsh(conn, command);
      const result = { code, output: output.trim() };
      results.push(result);
      if (result.code !== 0) break;
    }
    return results;
  } finally {
    conn.end();
  }
}
