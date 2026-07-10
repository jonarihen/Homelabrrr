import { ACTIONS, deleteArtifact, describeArtifact } from './catalog.js';
import { renderParams, evaluateCondition } from './template.js';

/**
 * Execution engine for configurable FortiGate workflows.
 *
 * Runs the enabled steps of a workflow in order against a live FortiGate client,
 * recording every created artifact. On a non-`continue_on_error` step failure it
 * rolls back everything created so far (reverse order) — the same guarantee as
 * the old hardcoded `provisionVlan`. Returns a structured run object (log +
 * artifacts + per-step outputs). On rollback it throws the original error with
 * the run attached as `err.workflowRun`.
 */

function nowIso() {
  return new Date().toISOString();
}

export async function runWorkflow({ steps, context, client }) {
  const orderedSteps = [...steps].sort((a, b) => a.position - b.position).filter((s) => s.enabled !== 0 && s.enabled !== false);

  const log = [];
  const artifacts = [];
  const outputs = {};
  // Expose earlier step outputs to templates as {{steps.<key>.<field>}}.
  const runContext = { ...context, steps: outputs };

  for (const step of orderedSteps) {
    const def = ACTIONS[step.action];
    const stepKey = step.step_key || `step${step.position}`;
    const entry = { ts: nowIso(), position: step.position, stepKey, action: step.action, label: step.label || def?.label || step.action, status: 'ok', calls: [] };

    if (!def) {
      entry.status = 'error';
      entry.error = `Unknown action "${step.action}"`;
      log.push(entry);
      await rollback(client, artifacts, log);
      const err = new Error(entry.error);
      err.workflowRun = { status: 'failed', log, artifacts: [] };
      throw err;
    }

    // Runtime condition gate (context-derived skips, e.g. optional DHCP).
    if (!evaluateCondition(step.condition, runContext)) {
      entry.status = 'condition_skipped';
      entry.summary = `Condition not met (${step.condition}) — skipped`;
      log.push(entry);
      continue;
    }

    let rendered;
    try {
      rendered = renderParams(step.params || {}, runContext);
      const result = await def.execute(client, rendered, runContext);
      outputs[stepKey] = result.output || {};
      entry.status = result.skipped ? 'skipped' : 'ok';
      entry.calls = result.calls || [];
      entry.output = result.output || {};
      if (result.note) entry.note = result.note;
      for (const a of (result.artifacts || [])) {
        artifacts.push({ ...a, stepKey });
      }
      entry.artifacts = (result.artifacts || []).map(describeArtifact);
      log.push(entry);
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
      entry.params = rendered;
      log.push(entry);

      if (step.continue_on_error === 1 || step.continue_on_error === true) {
        entry.status = 'error_ignored';
        entry.note = 'continue_on_error — run proceeded';
        continue;
      }

      await rollback(client, artifacts, log);
      const wrapped = new Error(err.message);
      wrapped.workflowRun = { status: 'failed', log, artifacts: [] };
      throw wrapped;
    }
  }

  return { status: 'success', log, artifacts, outputs };
}

async function rollback(client, artifacts, log) {
  if (artifacts.length === 0) return;
  const rbEntry = { ts: nowIso(), status: 'rolled_back', action: '(rollback)', label: 'Rollback', calls: [], reverted: [] };
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    const a = artifacts[i];
    try {
      await deleteArtifact(client, a);
      rbEntry.reverted.push({ artifact: describeArtifact(a), ok: true });
    } catch (e) {
      rbEntry.reverted.push({ artifact: describeArtifact(a), ok: false, error: e.message });
    }
  }
  log.push(rbEntry);
}

/**
 * Artifact-based teardown for deprovision. Deletes the recorded artifacts of a
 * previous run in reverse order (best-effort). Never re-derives from the current
 * workflow definition, so editing a workflow can't orphan objects.
 */
export async function teardownArtifacts(client, artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const log = [];
  const errors = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const a = list[i];
    const entry = { ts: nowIso(), artifact: describeArtifact(a), type: a.type, status: 'ok' };
    try {
      await deleteArtifact(client, a);
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message;
      errors.push(`${describeArtifact(a)}: ${e.message}`);
    }
    log.push(entry);
  }
  return { log, errors };
}

/**
 * Dry-run: render each enabled step and return the API calls it WOULD make,
 * without touching the firewall.
 */
export function previewWorkflow({ steps, context, client }) {
  const orderedSteps = [...steps].sort((a, b) => a.position - b.position);
  const outputs = {};
  const runContext = { ...context, steps: outputs };
  const preview = [];

  for (const step of orderedSteps) {
    const def = ACTIONS[step.action];
    const stepKey = step.step_key || `step${step.position}`;
    const item = { position: step.position, stepKey, action: step.action, label: step.label || def?.label || step.action, enabled: step.enabled !== 0 && step.enabled !== false };

    if (!def) { item.error = `Unknown action "${step.action}"`; preview.push(item); continue; }
    if (!item.enabled) { item.skipped = 'disabled'; preview.push(item); continue; }
    if (!evaluateCondition(step.condition, runContext)) { item.skipped = `condition not met (${step.condition})`; preview.push(item); continue; }

    let rendered;
    try {
      rendered = renderParams(step.params || {}, runContext);
      item.params = rendered;
      item.calls = typeof def.plan === 'function' ? def.plan(rendered, runContext, client) : [];
      // Provide plausible outputs so later {{steps.*}} references still render.
      outputs[stepKey] = predictOutput(step.action, rendered);
    } catch (err) {
      item.error = err.message;
    }
    preview.push(item);
  }

  return preview;
}

function predictOutput(action, p) {
  switch (action) {
    case 'create_vlan_interface': return { interfaceName: p.name };
    case 'create_address_object': return { name: p.name };
    case 'create_service_object': return { name: p.name };
    case 'create_vip': return { name: p.name };
    case 'create_policy': return { policyId: '(runtime id)' };
    case 'create_static_route': return { routeId: '(runtime id)' };
    case 'create_dhcp_server': return { dhcpServerId: '(runtime id)' };
    default: return {};
  }
}
