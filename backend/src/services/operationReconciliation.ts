import { eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client.ts';
import { provisionedVms, vmMigrations } from '../db/schema/index.ts';

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
  await database.delete(policy.table).where(eq(policy.table.id, row.id));
  return {
    ok: true,
    removed: row,
    consequence: 'Portal tracking removed; no Proxmox task, VM, disk, or configuration was changed.',
  };
}
