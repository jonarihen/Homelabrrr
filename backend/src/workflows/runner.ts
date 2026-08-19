import { runWorkflow, previewWorkflow, teardownArtifacts } from './engine.ts';
import { recordRun } from './store.ts';

/**
 * Sanitized firewall fields exposed to templates as `{{firewall.*}}`.
 * Never expose api_key.
 */
export function buildFirewallContext(fw) {
  return {
    id: fw.id,
    name: fw.name,
    host: fw.host,
    port: fw.port,
    vdom: fw.vdom,
    parent_interface: fw.parent_interface,
    wan_interface: fw.wan_interface,
    lab_vdom_link: fw.lab_vdom_link,
    root_vdom: fw.root_vdom || 'root',
    root_vdom_link: fw.root_vdom_link,
    route_gateway: fw.route_gateway,
    trunk_switch_serial: fw.trunk_switch_serial || '',
    trunk_switch_port: fw.trunk_switch_port || '',
    external_ip: fw.external_ip || '',
    root_wan_zone: fw.root_wan_zone || 'underlay',
  };
}

/**
 * Execute a workflow bundle against a live client, recording a run row.
 * On success returns { runId, outputs, artifacts }. On failure records a
 * 'failed' run (the engine already rolled back) and re-throws the original
 * error so the caller returns the same response it did historically.
 */
export async function runBundle(
  { bundle, context, client, firewall, subjectType, subjectId, subjectLabel, requestId = '' },
  { executeWorkflow = runWorkflow, saveRun = recordRun } = {},
) {
  const { workflow, steps } = bundle;
  try {
    const result = await executeWorkflow({ steps, context, client });
    const runId = await saveRun({
      workflowId: workflow.id,
      firewallId: firewall.id,
      trigger: workflow.trigger,
      subjectType,
      subjectId,
      subjectLabel,
      status: result.status,
      log: result.log,
      artifacts: result.artifacts,
      dryRun: false,
      requestId,
    });
    if (!Number.isInteger(runId)) {
      throw new TypeError('Workflow run recording did not return a numeric ID');
    }
    return { runId, outputs: result.outputs, artifacts: result.artifacts, status: result.status };
  } catch (err: any) {
    const failed = err.workflowRun || { status: 'failed', log: [{ status: 'error', error: err.message }], artifacts: [] };
    try {
      await saveRun({
        workflowId: workflow.id,
        firewallId: firewall.id,
        trigger: workflow.trigger,
        subjectType,
        subjectId,
        subjectLabel,
        status: failed.status,
        log: failed.log,
        artifacts: failed.artifacts,
        dryRun: false,
        requestId,
      });
    } catch (recordErr) {
      console.error('[workflows] Failed to record failed workflow run:', recordErr);
    }
    throw err;
  }
}

/** Dry-run preview — renders the calls without executing or recording. */
export function previewBundle({ bundle, context, client }) {
  return previewWorkflow({ steps: bundle.steps, context, client });
}

export { teardownArtifacts };
