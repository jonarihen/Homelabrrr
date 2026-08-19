import { eq, and, desc, inArray, count } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { DbOrTx } from '../db/client.ts';
import { workflows, workflowSteps, workflowRuns, firewalls } from '../db/schema/index.ts';
import { defaultSteps, defaultWorkflowName, TRIGGERS, TRIGGER_MAP } from './definitions.ts';

/**
 * Persistence + seeding for workflows/workflow_steps/workflow_runs.
 * Async Drizzle/PostgreSQL — every DB touch is awaited.
 */

function rowToStep(row: any) {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    position: row.position,
    step_key: row.step_key || '',
    action: row.action,
    label: row.label || '',
    // params is a jsonb column — already an object.
    params: row.params ?? {},
    condition: row.condition || '',
    enabled: row.enabled,
    continue_on_error: row.continue_on_error,
  };
}

// settings is a jsonb column — already an object.
export function workflowSettings(workflow: any) {
  return workflow?.settings ?? {};
}

// Insert a step list against a workflow. Runs on `db` or a transaction handle.
async function insertSteps(executor: DbOrTx, workflowId: number, steps: any[]) {
  if (!steps.length) return;
  const rows = steps.map((s, idx) => ({
    workflow_id: workflowId,
    position: idx,
    step_key: s.step_key || '',
    action: s.action,
    label: s.label || '',
    params: s.params || {},
    condition: s.condition || '',
    enabled: s.enabled === undefined ? true : !!s.enabled,
    continue_on_error: !!s.continue_on_error,
  }));
  await executor.insert(workflowSteps).values(rows);
}

/** Ensure every trigger has a workflow for this firewall (idempotent). */
export async function seedWorkflowsForFirewall(firewallId: number) {
  await db.transaction(async (tx) => {
    for (const meta of TRIGGERS) {
      const [existing] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.firewall_id, firewallId), eq(workflows.trigger, meta.trigger)))
        .limit(1);
      if (existing) continue;
      const [created] = await tx
        .insert(workflows)
        .values({
          firewall_id: firewallId,
          trigger: meta.trigger,
          name: defaultWorkflowName(meta.trigger),
          enabled: true,
          is_default: true,
          settings: {},
        })
        .returning({ id: workflows.id });
      await insertSteps(tx, created.id, defaultSteps(meta.trigger));
    }
  });
}

/** Seed defaults for every registered firewall (startup migration). */
export async function seedAllFirewalls() {
  const rows = await db.select({ id: firewalls.id }).from(firewalls);
  for (const fw of rows) {
    try { await seedWorkflowsForFirewall(fw.id); }
    catch (e: any) { console.warn(`[workflows] seed failed for firewall ${fw.id}: ${e.message}`); }
  }
  return rows.length;
}

export async function getWorkflowRow(firewallId: number, trigger: string) {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.firewall_id, firewallId), eq(workflows.trigger, trigger)))
    .limit(1);
  return row;
}

/**
 * Return the executable bundle { workflow, steps } bound to (firewall, trigger),
 * auto-seeding the default if none exists yet.
 */
export async function getWorkflowBundle(firewallId: number, trigger: string) {
  let workflow = await getWorkflowRow(firewallId, trigger);
  if (!workflow) {
    await seedWorkflowsForFirewall(firewallId);
    workflow = await getWorkflowRow(firewallId, trigger);
  }
  if (!workflow) return null;
  const stepRows = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.workflow_id, workflow.id))
    .orderBy(workflowSteps.position);
  return { workflow, steps: stepRows.map(rowToStep) };
}

export async function getWorkflowById(id: number) {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  if (!workflow) return null;
  const stepRows = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.workflow_id, id))
    .orderBy(workflowSteps.position);
  return { workflow, steps: stepRows.map(rowToStep) };
}

export async function listWorkflowsForFirewall(firewallId: number) {
  await seedWorkflowsForFirewall(firewallId);
  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.firewall_id, firewallId))
    .orderBy(workflows.trigger);
  if (rows.length === 0) return [];
  // Single grouped count instead of a COUNT(*) per workflow (was an N+1 loop).
  const ids = rows.map((w) => w.id);
  const counts = await db
    .select({ workflow_id: workflowSteps.workflow_id, c: count() })
    .from(workflowSteps)
    .where(inArray(workflowSteps.workflow_id, ids))
    .groupBy(workflowSteps.workflow_id);
  const countMap = new Map(counts.map((r) => [r.workflow_id, Number(r.c)]));
  return rows.map((w) => {
    const meta = TRIGGER_MAP[w.trigger] || null;
    return { ...w, settings: workflowSettings(w), stepCount: countMap.get(w.id) || 0, meta };
  });
}

export async function updateWorkflowMeta(id: number, { name, enabled, settings }: any) {
  const [existing] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  if (!existing) return false;
  await db
    .update(workflows)
    .set({
      name: name !== undefined ? String(name) : existing.name,
      enabled: enabled === undefined ? existing.enabled : !!enabled,
      settings: settings !== undefined ? (settings || {}) : existing.settings,
    })
    .where(eq(workflows.id, id));
  return true;
}

export async function replaceSteps(workflowId: number, steps: any[]) {
  await db.transaction(async (tx) => {
    await tx.delete(workflowSteps).where(eq(workflowSteps.workflow_id, workflowId));
    await insertSteps(tx, workflowId, steps);
    // Editing steps means it is no longer the pristine default.
    await tx.update(workflows).set({ is_default: false }).where(eq(workflows.id, workflowId));
  });
}

export async function resetWorkflow(id: number) {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  if (!workflow) return false;
  await db.transaction(async (tx) => {
    await tx.delete(workflowSteps).where(eq(workflowSteps.workflow_id, id));
    await insertSteps(tx, id, defaultSteps(workflow.trigger));
    await tx
      .update(workflows)
      .set({ is_default: true, enabled: true, settings: {}, name: defaultWorkflowName(workflow.trigger) })
      .where(eq(workflows.id, id));
  });
  return true;
}

export async function recordRun({ workflowId, firewallId, trigger, subjectType, subjectId, subjectLabel, status, log, artifacts, dryRun, requestId = '' }: any) {
  const [row] = await db
    .insert(workflowRuns)
    .values({
      workflow_id: workflowId || null,
      firewall_id: firewallId || null,
      trigger: trigger || '',
      subject_type: subjectType || '',
      // subject_id is a TEXT column.
      subject_id: subjectId != null ? String(subjectId) : '',
      subject_label: subjectLabel || '',
      status: status || 'pending',
      // log + artifacts are jsonb columns — store objects directly.
      log: log || [],
      artifacts: artifacts || [],
      dry_run: !!dryRun,
      request_id: requestId,
    })
    .returning({ id: workflowRuns.id });
  return row.id;
}

export async function getRun(id: number) {
  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
  if (!row) return null;
  return { ...row, log: row.log ?? [], artifacts: row.artifacts ?? [] };
}

export async function listRuns({ firewallId, trigger, subjectType, subjectId, limit = 50 }: any = {}) {
  const clauses = [];
  if (firewallId) clauses.push(eq(workflowRuns.firewall_id, Number(firewallId)));
  if (trigger) clauses.push(eq(workflowRuns.trigger, trigger));
  if (subjectType) clauses.push(eq(workflowRuns.subject_type, subjectType));
  if (subjectId != null && subjectId !== '') clauses.push(eq(workflowRuns.subject_id, String(subjectId)));
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(workflowRuns.created_at), desc(workflowRuns.id))
    .limit(lim);
  return rows.map((r) => ({ ...r, log: r.log ?? [], artifacts: r.artifacts ?? [] }));
}
