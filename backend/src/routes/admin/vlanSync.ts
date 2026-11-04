import { Router } from 'express';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vlans, firewalls, firewallVlanSync } from '../../db/schema/index.ts';
import { createClient } from '../../fortigate.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { isPortalAuthoredError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { getWorkflowBundle, workflowSettings } from '../../workflows/store.ts';
import { runBundle, teardownArtifacts } from '../../workflows/runner.ts';
import { deriveSubnet, interfaceCidr, syncedSubnet } from '../../workflows/subnet.ts';
import { pVlans, userOwnsVlan } from './shared.ts';
import {
  TrackingTargetGoneError,
  cleanupVlanPortForwards,
  deleteSyncUnlessForwarded,
  legacyForwardsNeedingReview,
  legacyReviewNote,
  legacyReviewPayload,
  lockFirewallForTracking,
  trackProvisioned,
  vlanProvisionContext,
} from './vlanHelpers.ts';

const router = Router();

// ─── VLAN ↔ Firewall Sync ─────────────────────────────────────────────────

router.get('/vlans/:id/sync', pVlans, async (req, res) => {
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, req.params.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const syncs = await db.select({
    ...getTableColumns(firewallVlanSync),
    firewall_name: firewalls.name,
    firewall_host: firewalls.host,
  }).from(firewallVlanSync)
    .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .where(eq(firewallVlanSync.vlan_id, Number(req.params.id)));
  res.json(syncs);
});

router.post('/vlans/:id/sync', pVlans, async (req, res) => {
  try {
    const [vlan] = await db.select().from(vlans).where(eq(vlans.id, Number(req.params.id))).limit(1);
    if (!vlan) return res.status(404).json({ error: 'VLAN not found' });
    if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, vlan.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (vlan.mode === 'tagged_only') {
      return res.status(400).json({ error: 'Tagged-only VLANs cannot be pushed to firewalls' });
    }

    const { firewallId, allowInternet = true, enableDhcp = true } = req.body;
    const fwRows = firewallId
      ? [(await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0]]
      : await db.select().from(firewalls);

    console.log(`[sync] VLAN ${vlan.tag} → ${fwRows.length} firewall(s), allowInternet=${allowInternet}, enableDhcp=${enableDhcp}`);

    const results = [];
    for (const fw of fwRows) {
      if (!fw) continue;
      // Skip if already synced
      const [existing] = await db.select({ id: firewallVlanSync.id }).from(firewallVlanSync)
        .where(and(eq(firewallVlanSync.firewall_id, fw.id), eq(firewallVlanSync.vlan_id, vlan.id))).limit(1);
      if (existing) { results.push({ firewall: fw.name, status: 'already_synced' }); continue; }

      // Validate VLAN tag is within this firewall's allowed range
      if (vlan.tag < fw.vlan_range_start || vlan.tag > fw.vlan_range_end) {
        results.push({ firewall: fw.name, status: 'error', error: `VLAN tag ${vlan.tag} is outside allowed range ${fw.vlan_range_start}–${fw.vlan_range_end}` });
        continue;
      }

      try {
        console.log(`[sync] Provisioning VLAN ${vlan.tag} on ${fw.name} (${fw.host}:${fw.port} vdom=${fw.vdom})`);
        const client = createClient(fw);

        // Provisioning now runs through the configurable workflow engine. The
        // seeded default `vlan_provision` workflow reproduces the historical
        // hardcoded sequence exactly; edits to it change what the next sync does.
        const bundle = await getWorkflowBundle(fw.id, 'vlan_provision');
        if (!bundle) throw new Error(`VLAN provision workflow is unavailable for firewall ${fw.name}`);
        const settings = workflowSettings(bundle.workflow);
        const subnet = deriveSubnet(vlan.tag, settings);
        if (!subnet) throw new Error(`Cannot derive subnet from VLAN tag ${vlan.tag}`);
        const context = vlanProvisionContext(vlan, fw, subnet, { allowInternet, enableDhcp });
        const { runId, outputs, artifacts } = await runBundle({
          bundle, context, client, firewall: fw,
          subjectType: 'vlan', subjectId: vlan.id, subjectLabel: `VLAN ${vlan.tag} (${vlan.name})`,
          requestId: req.requestId || '',
        });
        // Derive the legacy sync columns from step outputs generically so a
        // renamed/reordered workflow still populates them. Artifacts (stored
        // below) are the source of truth for teardown.
        const outVals = Object.values(outputs);
        const interfaceName = outVals.find((o) => o?.interfaceName)?.interfaceName || `vlan${vlan.tag}`;
        const policyIds = outVals.map((o) => o?.policyId).filter((v) => v !== undefined && v !== null);
        const dhcpServerId = outVals.find((o) => o?.dhcpServerId)?.dhcpServerId ?? null;
        const staticRouteId = outVals.find((o) => o?.routeId)?.routeId ?? null;
        // Record only the /24 of this VLAN's own interface (the interface step
        // whose vlanId is this tag), as configured or as found when the step
        // skipped an existing interface. Anything else → NULL = legacy default.
        const ifaceOut = outVals.find((o) => o?.interfaceName && Number(o.vlanId) === Number(vlan.tag));
        const provisionedCidr = interfaceCidr(ifaceOut, vlan.tag);
        // Report what was recorded; with no record readers use the legacy default, so show that, labelled.
        const recordedSubnet = syncedSubnet(vlan.tag, provisionedCidr, ifaceOut?.ip);
        const result = {
          interfaceName, policyIds, dhcpServerId, staticRouteId, subnet: recordedSubnet, subnetRecorded: !!provisionedCidr,
          ...(provisionedCidr ? {} : {
            warning: `Could not determine the subnet of VLAN ${vlan.tag}'s interface; none recorded, so policies use the legacy default ${recordedSubnet?.network}`,
          }),
        };
        console.log(`[sync] Success:`, JSON.stringify(result));
        // policy_ids and artifacts are jsonb columns — pass objects directly.
        await trackProvisioned(client, artifacts, () => db.transaction(async (tx) => {
          await lockFirewallForTracking(tx, fw.id);
          // DELETE /vlans/:id takes this row FOR UPDATE before its final re-check.
          const [liveVlan] = await tx.select({ id: vlans.id }).from(vlans).where(eq(vlans.id, vlan.id)).for('share');
          if (!liveVlan) throw new TrackingTargetGoneError('VLAN was deleted during provisioning');
          await tx.insert(firewallVlanSync).values({
            firewall_id: fw.id, vlan_id: vlan.id, interface_name: interfaceName,
            policy_ids: policyIds, dhcp_server_id: dhcpServerId, artifacts, workflow_run_id: runId,
            subnet_cidr: provisionedCidr,
          });
        }));
        await logAudit(req, 'admin_sync_vlan_firewall', `VLAN ${vlan.tag}`, `${fw.name}: ${interfaceName} (${provisionedCidr || `no subnet recorded; default ${recordedSubnet?.network}`})`);
        results.push({ firewall: fw.name, status: 'ok', ...result });
      } catch (err) {
        console.error(`[sync] Error provisioning VLAN ${vlan.tag} on ${fw.name}:`, err.message);
        results.push({ firewall: fw.name, status: 'error', error: isPortalAuthoredError(err) ? err.message : sanitizeError(err.message) });
      }
    }
    res.json(results);
  } catch (err) {
    console.error('[sync] Unexpected error:', err);
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

async function handleVlanUnsync(req: any, res: any, vlanIdRaw: any, firewallIdRaw: any) {
  const vlanId = Number(vlanIdRaw);
  const firewallId = Number(firewallIdRaw);
  if (!Number.isInteger(vlanId) || !Number.isInteger(firewallId)) {
    return res.status(400).json({ error: 'Invalid VLAN or firewall ID' });
  }
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, vlanId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const [sync] = await db.select({
    ...getTableColumns(firewalls),
    interface_name: firewallVlanSync.interface_name,
    policy_ids: firewallVlanSync.policy_ids,
    dhcp_server_id: firewallVlanSync.dhcp_server_id,
    artifacts: firewallVlanSync.artifacts,
    vlan_tag: vlans.tag,
  }).from(firewallVlanSync)
    .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
    .where(and(eq(firewallVlanSync.vlan_id, vlanId), eq(firewallVlanSync.firewall_id, firewallId)))
    .limit(1);
  if (!sync) return res.status(404).json({ error: 'Sync record not found' });

  try {
    // Port forwards into this VLAN would otherwise be orphaned (and still open) on the FortiGate.
    let errors = await cleanupVlanPortForwards(firewallId, sync, sync.interface_name);
    if (errors.length === 0) {
      const client = createClient(sync);
      const teardownRes = sync.artifacts
        ? await teardownArtifacts(client, sync.artifacts)
        : await client.deprovisionVlan(sync.interface_name, sync.policy_ids || [], sync.dhcp_server_id, {
          rootVdom: sync.root_vdom || 'root',
          trunkSwitchSerial: sync.trunk_switch_serial || '',
          trunkSwitchPort:   sync.trunk_switch_port   || '',
        });
      errors = teardownRes?.errors || [];
    }
    if (errors.length > 0) {
      console.warn(`[unsync-vlan] Teardown incomplete for VLAN ${vlanId} on firewall ${firewallId}:`, errors);
      await logAudit(
        req,
        'admin_unsync_vlan_firewall_failed',
        `VLAN ${vlanId}`,
        `Firewall ${firewallId} teardown failed: ${errors.join('; ')}`
      );
      return res.status(502).json({
        error: `Failed to remove VLAN from firewall: ${errors.map(sanitizeError).join('; ')}`,
        errors: errors.map(sanitizeError),
        details: errors.map(sanitizeError),
      });
    }
  } catch (err: any) {
    console.error('Deprovision error:', err.message);
    return res.status(502).json({ error: sanitizeError(err.message) });
  }

  if (!await deleteSyncUnlessForwarded(firewallId, vlanId, sync.interface_name)) {
    return res.status(409).json({ error: 'A port forward into this VLAN was created during the unsync; retry to remove it' });
  }
  const legacyForwards = await legacyForwardsNeedingReview(firewallId, sync.vlan_tag);
  await logAudit(req, 'admin_unsync_vlan_firewall', `VLAN ${vlanId}`, `Firewall ${firewallId}${legacyReviewNote(legacyForwards)}`);
  res.json({ ok: true, ...await legacyReviewPayload(req, legacyForwards) });
}

router.delete('/vlans/:id/sync/:firewallId', pVlans, async (req, res) => {
  await handleVlanUnsync(req, res, req.params.id, req.params.firewallId);
});

router.post('/firewalls/:id/vlans/:vlanId/unsync', pVlans, async (req, res) => {
  await handleVlanUnsync(req, res, req.params.vlanId, req.params.id);
});

router.delete('/firewalls/:id/vlans/:vlanId/sync', pVlans, async (req, res) => {
  await handleVlanUnsync(req, res, req.params.vlanId, req.params.id);
});

export default router;
