import db from '../db.ts';

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
];

const HOST_ID_DEPENDENCIES = [
  ['storage visibility rules', 'storage_visibility', 'pve_host_id'],
  ['maintenance windows', 'node_maintenance', 'pve_host_id'],
  ['public IP assignments', 'public_ip_assignments', 'proxmox_host_id'],
];

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function pveHostDependencies(hostId) {
  const parsedId = Number.parseInt(hostId, 10);
  if (!Number.isInteger(parsedId) || parsedId <= 0) throw new Error('Invalid Proxmox host id');
  const prefix = `${parsedId}~%`;
  const dependencies = [];

  for (const [label, table, column] of NODE_DEPENDENCIES) {
    if (!tableExists(table)) continue;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`).get(prefix).count;
    if (count) dependencies.push({ label, table, count });
  }
  if (tableExists('vm_migrations')) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM vm_migrations WHERE source_node LIKE ? OR target_node LIKE ?')
      .get(prefix, prefix).count;
    if (count) dependencies.push({ label: 'VM migrations', table: 'vm_migrations', count });
  }
  for (const [label, table, column] of HOST_ID_DEPENDENCIES) {
    if (!tableExists(table)) continue;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(parsedId).count;
    if (count) dependencies.push({ label, table, count });
  }

  return { hostId: parsedId, total: dependencies.reduce((sum, item) => sum + item.count, 0), dependencies };
}

export function deletePveHost(hostId) {
  const hostCount = db.prepare('SELECT COUNT(*) AS count FROM pve_hosts').get().count;
  if (hostCount <= 1) {
    const err = new Error('Cannot delete the last host');
    err.code = 'PVE_LAST_HOST';
    err.status = 400;
    throw err;
  }
  const report = pveHostDependencies(hostId);
  if (report.total > 0) {
    const err = new Error('Host still has portal resources and cannot be deleted');
    err.code = 'PVE_HOST_HAS_DEPENDENCIES';
    err.report = report;
    throw err;
  }
  const remove = db.transaction(() => db.prepare('DELETE FROM pve_hosts WHERE id = ?').run(report.hostId));
  return remove();
}
