const OPERATION_TYPES = {
  provision: { table: 'provisioned_vms', terminalStatuses: new Set(['ready', 'error', 'failed', 'timeout']) },
  migration: { table: 'vm_migrations', terminalStatuses: new Set(['ok', 'error', 'failed', 'timeout']) },
};

export function operationPhase(rawSteps) {
  let steps = [];
  try { steps = JSON.parse(rawSteps || '[]'); } catch { return ''; }
  if (!Array.isArray(steps)) return '';
  const current = steps.find((step) => !['done', 'skipped'].includes(step?.status)) || steps.at(-1);
  return current?.key || current?.label || '';
}

export function cleanupOperationTracking(database, type, id) {
  const policy = OPERATION_TYPES[type];
  if (!policy) throw new Error('Unsupported operation type');
  const row = database.prepare(`SELECT id, status, upid FROM ${policy.table} WHERE id = ?`).get(id);
  if (!row) return { ok: true, alreadyAbsent: true };
  if (!policy.terminalStatuses.has(row.status)) {
    return { ok: false, blocked: true, status: row.status };
  }
  database.prepare(`DELETE FROM ${policy.table} WHERE id = ?`).run(row.id);
  return {
    ok: true,
    removed: row,
    consequence: 'Portal tracking removed; no Proxmox task, VM, disk, or configuration was changed.',
  };
}
