import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { provisionedVms, users, vmAssignments } from '../db/schema/index.ts';
import { getAllVMs, getTaskStatus, getProvisionVMConfig } from '../proxmox.ts';
import { assertUserQuota } from '../utils/quota.ts';
import { createLeaseForVm } from '../utils/leases.ts';
import { httpError } from '../utils/httpError.ts';
import { nodeLookupCandidates } from '../utils/nodeRef.ts';
import { provisionAllocation, type ProvisionAllocation } from '../utils/provisionIntent.ts';

type ProvisionRow = typeof provisionedVms.$inferInsert;

async function lockQuota(database: DbOrTx, userId: number) {
  await database.execute(sql`SELECT pg_advisory_xact_lock(208, ${userId})`);
}

export async function submitProvision(
  row: ProvisionRow,
  intent: Omit<ProvisionAllocation, 'version' | 'state'>,
  submit: (onReserved: (vmid: number) => Promise<void>) => Promise<{ vmid: number; result: string | null }>,
) {
  if (!provisionAllocation([{ key: 'reserve', allocation: { ...intent, version: 1, state: 'pending' } }])) {
    throw httpError(400, 'Invalid provisioning owner or resource allocation');
  }
  const liveVms = await getAllVMs();
  const provisionId = await db.transaction(async tx => {
    const quotaUser = intent.userId ?? row.user_id;
    await lockQuota(tx, quotaUser);
    const participants = [...new Set([row.user_id, quotaUser])].sort((a, b) => a - b);
    const lockedUsers = await tx.select({ id: users.id }).from(users).where(inArray(users.id, participants))
      .orderBy(users.id).for('update');
    if (lockedUsers.length !== participants.length) throw httpError(400, 'The provisioning actor or intended owner no longer exists');
    await assertUserQuota(quotaUser, { addCores: intent.cores, addMemoryMb: intent.memoryMb, addDiskGb: intent.diskGb }, tx, liveVms);
    const steps = structuredClone(row.steps) as any[];
    const reserve = steps.find(step => step.key === 'reserve');
    if (!reserve) throw new Error('Provisioning reservation step is missing');
    reserve.allocation = { ...intent, version: 1, state: 'pending' } satisfies ProvisionAllocation;
    const [saved] = await tx.insert(provisionedVms).values({ ...row, steps, vmid: 0, status: 'submitting' })
      .returning({ id: provisionedVms.id });
    return saved.id;
  });
  let submitted: { vmid: number; result: string | null };
  try {
    submitted = await submit(async vmid => {
      await db.update(provisionedVms).set({ vmid }).where(eq(provisionedVms.id, provisionId));
    });
  } catch (err: any) {
    const rejected = err?.definitiveRejection === true;
    await db.update(provisionedVms).set({
      status: rejected ? 'error' : 'needs_review',
      status_detail: rejected ? 'Upstream submission was rejected' : 'Submission outcome is unknown — verify the reserved VMID and upstream task before resolving',
    }).where(eq(provisionedVms.id, provisionId));
    throw err;
  }
  const { vmid, result: upid } = submitted;
  await db.update(provisionedVms).set({ vmid, upid: upid || '', status: row.status })
    .where(eq(provisionedVms.id, provisionId));
  return { provisionId, vmid, upid };
}

export async function assertUserCanBeDeleted(database: DbOrTx, userId: number) {
  await database.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  const jobs = await database.select({ id: provisionedVms.id, user_id: provisionedVms.user_id, steps: provisionedVms.steps })
    .from(provisionedVms).where(inArray(provisionedVms.status, ['submitting', 'creating', 'cloning', 'configuring', 'needs_review', 'timeout']));
  if (jobs.some(job => job.user_id === userId || provisionAllocation(job.steps)?.userId === userId)) {
    throw httpError(409, 'Resolve pending provisioning operations before deleting this actor or intended VM owner');
  }
}

export async function recordProvisionOwnership(id: number, verifiedRecovery = false, resolvedDetail?: string) {
  const [saved] = await db.select().from(provisionedVms).where(eq(provisionedVms.id, id)).limit(1);
  if (!saved || !provisionAllocation(saved.steps)) {
    throw httpError(409, 'This operation has no persisted owner intent; verify and assign it manually');
  }
  if (verifiedRecovery) {
    if (saved.status !== 'needs_review') throw httpError(409, 'Only interrupted provisioning can recover ownership');
    if (!saved.upid) throw httpError(409, 'Cannot recover ownership without a saved successful task');
    const task = await getTaskStatus(saved.node, saved.upid);
    if (task.status !== 'stopped' || task.exitstatus !== 'OK') throw httpError(409, 'The saved task has not completed successfully');
    const config = await getProvisionVMConfig(saved.node, saved.vmid);
    if (config.name !== saved.name) throw httpError(409, 'The current VM does not match this provisioning operation');
  }
  await db.transaction(async tx => {
    const intent = provisionAllocation(saved.steps)!;
    await lockQuota(tx, intent.userId ?? saved.user_id);
    const [row] = await tx.select().from(provisionedVms).where(eq(provisionedVms.id, id)).for('update').limit(1);
    if (!row || row.upid !== saved.upid || row.vmid !== saved.vmid) throw httpError(409, 'Provisioning changed during ownership recovery');
    if (verifiedRecovery && row.status !== 'needs_review') throw httpError(409, 'Provisioning changed during ownership recovery');
    if (!verifiedRecovery && !['creating', 'cloning', 'configuring', 'needs_review'].includes(row.status!)) {
      throw httpError(409, 'Provisioning is no longer awaiting ownership');
    }
    const allocation = provisionAllocation(row.steps);
    if (!allocation) throw httpError(409, 'Provisioning owner intent changed');
    if (allocation.state === 'released') throw httpError(409, 'This provisioning allocation has been released');
    if (allocation.state !== 'pending') {
      if (resolvedDetail && allocation.state === 'owned') {
        await tx.update(provisionedVms).set({ status: 'ready', status_detail: resolvedDetail }).where(eq(provisionedVms.id, id));
      }
      return;
    }
    const history = await tx.select({ id: provisionedVms.id }).from(provisionedVms)
      .where(eq(provisionedVms.vmid, row.vmid));
    if (history.some(job => job.id > row.id)) throw httpError(409, 'A newer provisioning operation uses this VMID; verify ownership manually');
    const candidates = nodeLookupCandidates(row.node);
    if (candidates.length === 0) throw httpError(409, 'Provisioning node is missing');
    const assignments = await tx.select().from(vmAssignments)
      .where(and(eq(vmAssignments.vmid, row.vmid), inArray(vmAssignments.node, candidates)));
    if (assignments.some(assignment => assignment.user_id !== allocation.userId)) {
      throw httpError(409, 'This VM already has a different owner; verify ownership manually');
    }
    if (allocation.userId && assignments.length === 0) {
      await tx.insert(vmAssignments).values({ user_id: allocation.userId, node: row.node, vmid: row.vmid });
    }
    await createLeaseForVm(row.node, row.vmid, { createdBy: allocation.createdBy }, tx);
    const steps = structuredClone(row.steps) as any[];
    const stored = steps.find(step => step.key === 'reserve').allocation;
    stored.state = 'owned';
    stored.ownedAt = Date.now();
    await tx.update(provisionedVms).set({ steps, ...(resolvedDetail ? { status: 'ready', status_detail: resolvedDetail } : {}) })
      .where(eq(provisionedVms.id, id));
  });
}
