import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { catalogMeta, validateStep, ACTIONS } from '../workflows/catalog.js';
import { TRIGGERS, TRIGGER_VARIABLES } from '../workflows/definitions.js';
import {
  listWorkflowsForFirewall, getWorkflowById, updateWorkflowMeta, replaceSteps,
  resetWorkflow, workflowSettings, listRuns, getRun,
} from '../workflows/store.js';
import { previewBundle, buildFirewallContext } from '../workflows/runner.js';
import { deriveSubnet } from '../workflows/subnet.js';

const router = Router();
router.use(requireAuth);

// Everything here is firewall-adjacent — gate on can_manage_firewalls.
const pFirewalls = requirePermission('can_manage_firewalls');

function getFirewall(id) {
  return db.prepare('SELECT * FROM firewalls WHERE id = ?').get(id);
}

// Preview-only VIP naming (mirrors admin.js; display-only, never used for real runs).
function previewServiceName(vipName, protocol, port) {
  const safeName = String(vipName || 'vip').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'vip';
  return `VMM-PF-${String(protocol || 'tcp').toUpperCase()}-${port}-${safeName}`;
}
function previewAddressName(vipName, mappedIp) {
  const safeName = String(vipName || 'vip').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'vip';
  const safeIp = String(mappedIp || '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'host';
  return `VMM-PF-HOST-${safeIp}-${safeName}`;
}

/**
 * Build a sample run context for a dry-run against user-supplied inputs.
 */
function buildSampleContext(trigger, fw, inputs, settings) {
  const firewall = buildFirewallContext(fw);
  const trunkConfigured = !!(fw.trunk_switch_serial && fw.trunk_switch_port);

  if (trigger === 'vlan_provision' || trigger === 'vlan_deprovision') {
    const tag = parseInt(inputs.tag, 10) || fw.vlan_range_start || 1001;
    const subnet = deriveSubnet(tag, settings) || {};
    return {
      firewall, tag, name: inputs.name || `vlan-${tag}`, subnet,
      allowInternet: inputs.allowInternet !== false,
      enableDhcp: inputs.enableDhcp !== false,
      trunkConfigured,
    };
  }

  if (trigger === 'port_forward_create' || trigger === 'port_forward_delete') {
    const name = inputs.name || 'sample-forward';
    const protocol = (inputs.protocol || 'tcp').toLowerCase();
    const internalPort = inputs.internalPort || 22;
    const internalIp = inputs.internalIp || '10.11.26.50';
    const vlanInterface = inputs.vlanInterface || `vlan${inputs.tag || 1126}`;
    return {
      firewall,
      name, protocol,
      externalPort: inputs.externalPort || 2222,
      internalIp, internalPort,
      dstInterface: inputs.dstInterface || fw.root_vdom_link || 'lab-root1',
      vlanInterface,
      srcAddresses: Array.isArray(inputs.srcAddresses) && inputs.srcAddresses.length ? inputs.srcAddresses : ['all'],
      serviceName: previewServiceName(name, protocol, internalPort),
      labAddressName: vlanInterface ? previewAddressName(name, internalIp) : '',
      externalIp: fw.external_ip || '203.0.113.10',
      wanZone: fw.root_wan_zone || 'underlay',
      rootVdom: fw.root_vdom || 'root',
      labVdom: fw.vdom || 'lab',
      labSrcInterface: fw.lab_vdom_link || 'lab-root0',
    };
  }

  if (trigger === 'policy_create' || trigger === 'policy_delete') {
    const srcIf = inputs.srcInterface || `vlan${inputs.srcTag || 1126}`;
    const dstIf = inputs.dstInterface || `vlan${inputs.dstTag || 1127}`;
    return {
      firewall,
      action: inputs.action || 'accept',
      bidirectional: inputs.bidirectional === true,
      services: Array.isArray(inputs.services) && inputs.services.length ? inputs.services : ['ALL'],
      srcVlan: { interface_name: srcIf, name: inputs.srcName || srcIf, tag: inputs.srcTag || 1126 },
      dstVlan: { interface_name: dstIf, name: inputs.dstName || dstIf, tag: inputs.dstTag || 1127 },
      srcAddrName: inputs.srcAddrName || `NET-10.11.26.0_24`,
      dstAddrName: inputs.dstAddrName || `NET-10.11.27.0_24`,
    };
  }

  return { firewall, ...inputs };
}

// ─── Catalog & metadata ───────────────────────────────────────────────────────
router.get('/catalog', pFirewalls, (req, res) => {
  res.json({ actions: catalogMeta(), triggers: TRIGGERS, variables: TRIGGER_VARIABLES });
});

// ─── List / read workflows ────────────────────────────────────────────────────
router.get('/', pFirewalls, (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = getFirewall(firewallId);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    res.json(listWorkflowsForFirewall(fw.id));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/runs', pFirewalls, (req, res) => {
  const { firewallId, trigger, subjectType, subjectId, limit } = req.query;
  const runs = listRuns({ firewallId, trigger, subjectType, subjectId, limit });
  res.json(runs);
});

router.get('/runs/:id', pFirewalls, (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

router.get('/:id', pFirewalls, (req, res) => {
  const bundle = getWorkflowById(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ ...bundle.workflow, settings: workflowSettings(bundle.workflow), steps: bundle.steps });
});

// ─── Update workflow meta (name, enabled, settings) ───────────────────────────
router.put('/:id', pFirewalls, (req, res) => {
  const bundle = getWorkflowById(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Workflow not found' });
  const { name, enabled, settings } = req.body;
  if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
    return res.status(400).json({ error: 'settings must be an object' });
  }
  updateWorkflowMeta(bundle.workflow.id, { name, enabled, settings });
  logAudit(req, 'workflow_update', `${bundle.workflow.trigger} (fw ${bundle.workflow.firewall_id})`, `name=${name ?? bundle.workflow.name} enabled=${enabled}`);
  res.json({ ok: true });
});

// ─── Replace steps ────────────────────────────────────────────────────────────
router.put('/:id/steps', pFirewalls, (req, res) => {
  const bundle = getWorkflowById(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Workflow not found' });
  const { steps } = req.body;
  if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps must be an array' });

  // Validate every step against the catalog before persisting anything.
  const normalized = [];
  for (const [i, s] of steps.entries()) {
    if (!s || !ACTIONS[s.action]) {
      return res.status(400).json({ error: `Step ${i + 1}: unknown or missing action` });
    }
    try {
      validateStep(s.action, s.params || {});
    } catch (err) {
      return res.status(400).json({ error: `Step ${i + 1} (${s.action}): ${err.message}` });
    }
    normalized.push({
      step_key: s.step_key || s.action + i,
      action: s.action,
      label: s.label || '',
      params: s.params || {},
      condition: s.condition || '',
      enabled: s.enabled === undefined ? 1 : (s.enabled ? 1 : 0),
      continue_on_error: s.continue_on_error ? 1 : 0,
    });
  }

  try {
    replaceSteps(bundle.workflow.id, normalized);
    logAudit(req, 'workflow_edit_steps', `${bundle.workflow.trigger} (fw ${bundle.workflow.firewall_id})`, `${normalized.length} step(s)`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Reset to built-in default ────────────────────────────────────────────────
router.post('/:id/reset', pFirewalls, (req, res) => {
  const bundle = getWorkflowById(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Workflow not found' });
  resetWorkflow(bundle.workflow.id);
  logAudit(req, 'workflow_reset', `${bundle.workflow.trigger} (fw ${bundle.workflow.firewall_id})`, 'reset to default');
  res.json({ ok: true });
});

// ─── Dry-run preview ──────────────────────────────────────────────────────────
router.post('/:id/dry-run', pFirewalls, (req, res) => {
  const bundle = getWorkflowById(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Workflow not found' });
  const fw = getFirewall(bundle.workflow.firewall_id);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const settings = workflowSettings(bundle.workflow);
    const context = buildSampleContext(bundle.workflow.trigger, fw, req.body?.inputs || {}, settings);
    const pseudoClient = { vdom: fw.vdom || 'root' };
    const preview = previewBundle({ bundle, context, client: pseudoClient });
    logAudit(req, 'workflow_dry_run', `${bundle.workflow.trigger} (fw ${fw.id})`, '');
    res.json({ context, preview });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
