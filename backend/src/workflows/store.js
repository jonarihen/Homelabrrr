import db from '../db.js';
import { defaultSteps, defaultWorkflowName, TRIGGERS, TRIGGER_MAP } from './definitions.js';

/**
 * Persistence + seeding for workflows/workflow_steps/workflow_runs.
 * better-sqlite3 is synchronous — no awaits here.
 */

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowToStep(row) {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    position: row.position,
    step_key: row.step_key || '',
    action: row.action,
    label: row.label || '',
    params: parseJson(row.params, {}),
    condition: row.condition || '',
    enabled: row.enabled,
    continue_on_error: row.continue_on_error,
  };
}

export function workflowSettings(workflow) {
  return parseJson(workflow?.settings, {});
}

const insertWorkflowStmt = db.prepare(
  'INSERT INTO workflows (firewall_id, trigger, name, enabled, is_default, settings) VALUES (?, ?, ?, 1, 1, ?)'
);
const insertStepStmt = db.prepare(
  'INSERT INTO workflow_steps (workflow_id, position, step_key, action, label, params, condition, enabled, continue_on_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

function insertSteps(workflowId, steps) {
  steps.forEach((s, idx) => {
    insertStepStmt.run(
      workflowId,
      idx,
      s.step_key || '',
      s.action,
      s.label || '',
      JSON.stringify(s.params || {}),
      s.condition || '',
      s.enabled === undefined ? 1 : (s.enabled ? 1 : 0),
      s.continue_on_error ? 1 : 0
    );
  });
}

const seedFirewallTx = db.transaction((firewallId) => {
  for (const meta of TRIGGERS) {
    const existing = db.prepare('SELECT id FROM workflows WHERE firewall_id = ? AND trigger = ?').get(firewallId, meta.trigger);
    if (existing) continue;
    const res = insertWorkflowStmt.run(firewallId, meta.trigger, defaultWorkflowName(meta.trigger), '{}');
    insertSteps(res.lastInsertRowid, defaultSteps(meta.trigger));
  }
});

/** Ensure every trigger has a workflow for this firewall (idempotent). */
export function seedWorkflowsForFirewall(firewallId) {
  seedFirewallTx(firewallId);
}

/** Seed defaults for every registered firewall (startup migration). */
export function seedAllFirewalls() {
  const firewalls = db.prepare('SELECT id FROM firewalls').all();
  for (const fw of firewalls) {
    try { seedWorkflowsForFirewall(fw.id); }
    catch (e) { console.warn(`[workflows] seed failed for firewall ${fw.id}: ${e.message}`); }
  }
  return firewalls.length;
}

export function getWorkflowRow(firewallId, trigger) {
  return db.prepare('SELECT * FROM workflows WHERE firewall_id = ? AND trigger = ?').get(firewallId, trigger);
}

/**
 * Return the executable bundle { workflow, steps } bound to (firewall, trigger),
 * auto-seeding the default if none exists yet.
 */
export function getWorkflowBundle(firewallId, trigger) {
  let workflow = getWorkflowRow(firewallId, trigger);
  if (!workflow) {
    seedWorkflowsForFirewall(firewallId);
    workflow = getWorkflowRow(firewallId, trigger);
  }
  if (!workflow) return null;
  const steps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position').all(workflow.id).map(rowToStep);
  return { workflow, steps };
}

export function getWorkflowById(id) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!workflow) return null;
  const steps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position').all(id).map(rowToStep);
  return { workflow, steps };
}

export function listWorkflowsForFirewall(firewallId) {
  seedWorkflowsForFirewall(firewallId);
  const workflows = db.prepare('SELECT * FROM workflows WHERE firewall_id = ? ORDER BY trigger').all(firewallId);
  return workflows.map((w) => {
    const stepCount = db.prepare('SELECT COUNT(*) AS c FROM workflow_steps WHERE workflow_id = ?').get(w.id).c;
    const meta = TRIGGER_MAP[w.trigger] || null;
    return { ...w, settings: workflowSettings(w), stepCount, meta };
  });
}

export function updateWorkflowMeta(id, { name, enabled, settings }) {
  const existing = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('UPDATE workflows SET name = ?, enabled = ?, settings = ? WHERE id = ?').run(
    name !== undefined ? String(name) : existing.name,
    enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
    settings !== undefined ? JSON.stringify(settings || {}) : existing.settings,
    id
  );
  return true;
}

const replaceStepsTx = db.transaction((workflowId, steps) => {
  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(workflowId);
  insertSteps(workflowId, steps);
  // Editing steps means it is no longer the pristine default.
  db.prepare('UPDATE workflows SET is_default = 0 WHERE id = ?').run(workflowId);
});

export function replaceSteps(workflowId, steps) {
  replaceStepsTx(workflowId, steps);
}

const resetTx = db.transaction((id, trigger) => {
  db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(id);
  insertSteps(id, defaultSteps(trigger));
  db.prepare('UPDATE workflows SET is_default = 1, enabled = 1, settings = ?, name = ? WHERE id = ?').run('{}', defaultWorkflowName(trigger), id);
});

export function resetWorkflow(id) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!workflow) return false;
  resetTx(id, workflow.trigger);
  return true;
}

export function recordRun({ workflowId, firewallId, trigger, subjectType, subjectId, subjectLabel, status, log, artifacts, dryRun }) {
  const res = db.prepare(
    'INSERT INTO workflow_runs (workflow_id, firewall_id, trigger, subject_type, subject_id, subject_label, status, log, artifacts, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    workflowId || null,
    firewallId || null,
    trigger || '',
    subjectType || '',
    subjectId != null ? String(subjectId) : '',
    subjectLabel || '',
    status || 'pending',
    JSON.stringify(log || []),
    JSON.stringify(artifacts || []),
    dryRun ? 1 : 0
  );
  return res.lastInsertRowid;
}

export function getRun(id) {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, log: parseJson(row.log, []), artifacts: parseJson(row.artifacts, []) };
}

export function listRuns({ firewallId, trigger, subjectType, subjectId, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (firewallId) { clauses.push('firewall_id = ?'); params.push(firewallId); }
  if (trigger) { clauses.push('trigger = ?'); params.push(trigger); }
  if (subjectType) { clauses.push('subject_type = ?'); params.push(subjectType); }
  if (subjectId != null && subjectId !== '') { clauses.push('subject_id = ?'); params.push(String(subjectId)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM workflow_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  return rows.map((r) => ({ ...r, log: parseJson(r.log, []), artifacts: parseJson(r.artifacts, []) }));
}
