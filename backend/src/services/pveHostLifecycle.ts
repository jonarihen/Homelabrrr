import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { pveHosts } from '../db/schema/index.ts';
import { count, eq } from 'drizzle-orm';

const NODE_DEPENDENCIES = [
  ['VM assignments', 'vm_assignments', 'node'],
  ['SSH configurations', 'vm_ssh_configs', 'node'],
  ['per-user SSH configurations', 'vm_ssh_user_configs', 'node'],
  ['templates', 'vm_templates', 'node'],
  ['cloud images', 'cloud_images', 'node'],
  ['ISO images', 'isos', 'node'],
  ['provisioning jobs', 'provisioned_vms', 'node'],
  ['backup jobs', 'backup_tasks', 'node'],
  ['VM leases', 'vm_leases', 'node'],
  ['power schedules', 'vm_schedules', 'node'],
] as const;

const HOST_ID_DEPENDENCIES = [
  ['storage visibility rules', 'storage_visibility', 'pve_host_id'],
  ['maintenance windows', 'node_maintenance', 'pve_host_id'],
  ['public IP assignments', 'public_ip_assignments', 'proxmox_host_id'],
] as const;

// Table/column names here are compile-time constants (the whitelist), so they
// are safe to emit through sql.identifier. to_regclass returns NULL for a table
// that does not exist — the PostgreSQL equivalent of the old sqlite_master probe.
async function tableExists(name: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`);
  return Boolean((result.rows[0] as { present: boolean }).present);
}

async function countWhere(fragment: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(fragment);
  return Number((result.rows[0] as { count: number | string }).count);
}

export async function pveHostDependencies(hostId: number | string) {
  const parsedId = Number.parseInt(String(hostId), 10);
  if (!Number.isInteger(parsedId) || parsedId <= 0) throw new Error('Invalid Proxmox host id');
  // Every node value belonging to this host is prefixed '<hostId>~' (utils/nodeRef.ts),
  // so a LIKE prefix scan finds all of them.
  const prefix = `${parsedId}~%`;
  const dependencies: { label: string; table: string; count: number }[] = [];

  for (const [label, table, column] of NODE_DEPENDENCIES) {
    if (!(await tableExists(table))) continue;
    const c = await countWhere(
      sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} LIKE ${prefix}`,
    );
    if (c) dependencies.push({ label, table, count: c });
  }
  if (await tableExists('vm_migrations')) {
    const c = await countWhere(
      sql`SELECT COUNT(*) AS count FROM vm_migrations WHERE source_node LIKE ${prefix} OR target_node LIKE ${prefix}`,
    );
    if (c) dependencies.push({ label: 'VM migrations', table: 'vm_migrations', count: c });
  }
  for (const [label, table, column] of HOST_ID_DEPENDENCIES) {
    if (!(await tableExists(table))) continue;
    const c = await countWhere(
      sql`SELECT COUNT(*) AS count FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${parsedId}`,
    );
    if (c) dependencies.push({ label, table, count: c });
  }

  return { hostId: parsedId, total: dependencies.reduce((sum, item) => sum + item.count, 0), dependencies };
}

export async function deletePveHost(hostId: number | string) {
  const [{ n: hostCount }] = await db.select({ n: count() }).from(pveHosts);
  if (hostCount <= 1) {
    const err = new Error('Cannot delete the last host') as Error & { code?: string; status?: number };
    err.code = 'PVE_LAST_HOST';
    err.status = 400;
    throw err;
  }
  const report = await pveHostDependencies(hostId);
  if (report.total > 0) {
    const err = new Error('Host still has portal resources and cannot be deleted') as Error & {
      code?: string;
      report?: unknown;
    };
    err.code = 'PVE_HOST_HAS_DEPENDENCIES';
    err.report = report;
    throw err;
  }
  return db.transaction(async (tx) => {
    const result = await tx.delete(pveHosts).where(eq(pveHosts.id, report.hostId));
    return result.rowCount ?? 0;
  });
}
