import { and, eq, inArray } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client.ts';
import { provisionedVms, vmMigrations, vmAssignments, vmLeases } from '../db/schema/index.ts';
import { nodeLookupCandidates } from '../utils/nodeRef.ts';
import { provisionAllocation } from '../utils/provisionIntent.ts';

interface OperationPolicy {
  table: PgTable & { id: typeof provisionedVms.id; status: typeof provisionedVms.status };
  terminalStatuses: Set<string>;
}

const OPERATION_TYPES: Record<string, OperationPolicy> = {
  provision: { table: provisionedVms as never, terminalStatuses: new Set(['ready', 'error', 'failed', 'timeout']) },
  migration: { table: vmMigrations as never, terminalStatuses: new Set(['ok', 'error', 'failed', 'timeout']) },
};

// The `steps` column is jsonb now: callers pass a parsed array. A legacy string
// (or anything unexpected) is tolerated and yields ''.
export function operationPhase(rawSteps: unknown): string {
  let steps: unknown = rawSteps;
  if (typeof rawSteps === 'string') {
    try { steps = JSON.parse(rawSteps || '[]'); } catch { return ''; }
  }
  if (!Array.isArray(steps)) return '';
  const current = steps.find((step) => !['done', 'skipped'].includes(step?.status)) || steps.at(-1);
  return current?.key || current?.label || '';
}

export async function failedCreateOwnershipReview(database: DbOrTx, id: number) {
  const [row] = await database.select().from(provisionedVms).where(eq(provisionedVms.id, id)).limit(1);
  if (!row || row.source_type !== 'create' || row.status !== 'error') return null;
  const candidates = nodeLookupCandidates(row.node);
  if (candidates.length === 0) return null;
  const [assignments, leases, history] = await Promise.all([
    database.select().from(vmAssignments)
      .where(and(eq(vmAssignments.vmid, row.vmid), inArray(vmAssignments.node, candidates))),
    database.select().from(vmLeases)
      .where(and(eq(vmLeases.vmid, row.vmid), inArray(vmLeases.node, candidates))),
    database.select({
      id: provisionedVms.id, node: provisionedVms.node, name: provisionedVms.name,
      user_id: provisionedVms.user_id, source_type: provisionedVms.source_type,
      status: provisionedVms.status, upid: provisionedVms.upid, created_at: provisionedVms.created_at,
    }).from(provisionedVms).where(eq(provisionedVms.vmid, row.vmid)),
  ]);
  return {
    automaticCleanup: false,
    assignments,
    leases,
    history,
    detail: 'Ownership rows were not deleted: legacy assignments have no provisioning/task link or creation timestamp, and may belong to a later or manually assigned VM. Verify the VMID across reachable Proxmox clusters and review its history before removing any rows; a failed task or an incomplete VM listing does not prove absence.',
  };
}

export async function cleanupOperationTracking(database: DbOrTx, type: string, id: number) {
  const policy = OPERATION_TYPES[type];
  if (!policy) throw new Error('Unsupported operation type');
  const [row] = await database
    .select({ id: policy.table.id, status: policy.table.status })
    .from(policy.table)
    .where(eq(policy.table.id, id))
    .limit(1);
  if (!row) return { ok: true, alreadyAbsent: true };
  if (!policy.terminalStatuses.has(row.status)) {
    return { ok: false, blocked: true, status: row.status };
  }
  if (type === 'provision') {
    const [provision] = await database.select().from(provisionedVms).where(eq(provisionedVms.id, id)).limit(1);
    const intent = provisionAllocation(provision?.steps);
    if (intent && intent.state === 'pending' && provision?.status !== 'error') {
      return { ok: false, blocked: true, status: row.status };
    }
  }
  await database.delete(policy.table).where(eq(policy.table.id, row.id));
  return {
    ok: true,
    removed: row,
    consequence: 'Portal tracking removed; no Proxmox task, VM, disk, or configuration was changed.',
  };
}
