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
async function ownershipEvidence(database: DbOrTx, rows: Array<{ id: number; node: string; vmid: number }>) {
  if (rows.length === 0) return new Map();
  const vmids = [...new Set(rows.map(row => row.vmid))];
  const nodes = [...new Set(rows.flatMap(row => nodeLookupCandidates(row.node)))];
  const assignments = await database.select().from(vmAssignments)
    .where(and(inArray(vmAssignments.vmid, vmids), inArray(vmAssignments.node, nodes)));
  const leases = await database.select().from(vmLeases)
    .where(and(inArray(vmLeases.vmid, vmids), inArray(vmLeases.node, nodes)));
  const history = await database.select().from(provisionedVms).where(inArray(provisionedVms.vmid, vmids));
  const evidence = new Map();
  for (const row of rows) {
    const ids = new Set(nodeLookupCandidates(row.node));
    evidence.set(row.id, {
      automaticCleanup: false,
      assignments: assignments.filter(a => a.vmid === row.vmid && ids.has(a.node)),
      leases: leases.filter(l => l.vmid === row.vmid && ids.has(l.node)),
      history: history.filter(h => h.vmid === row.vmid),
      detail: 'Ownership rows were not deleted: legacy assignments have no provisioning/task link or creation timestamp, and may belong to a later or manually assigned VM. Verify the VMID across reachable Proxmox clusters and review its history before removing any rows; a failed task or an incomplete VM listing does not prove absence.',
    });
  }
  return evidence;
}

export async function failedCreateOwnershipReviews(database: DbOrTx, rows: Array<{ id: number; node: string; vmid: number }>) {
  return ownershipEvidence(database, rows);
}

export async function failedCreateOwnershipReview(database: DbOrTx, id: number) {
  const [row] = await database.select().from(provisionedVms).where(eq(provisionedVms.id, id)).limit(1);
  if (!row || row.source_type !== 'create' || row.status !== 'error') return null;
  const candidates = nodeLookupCandidates(row.node);
  if (candidates.length === 0) return null;
  const evidence = await ownershipEvidence(database, [{ id: row.id, node: row.node, vmid: row.vmid }]);
  return evidence.get(row.id) ?? null;
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
