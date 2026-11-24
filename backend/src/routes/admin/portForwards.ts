import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vlans, firewalls, firewallVlanSync, managedVips, publicIps, publicIpPools, publicIpAssignments } from '../../db/schema/index.ts';
import { createClient } from '../../fortigate.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { logAudit } from '../../utils/audit.ts';
import { shortenVipName, PORT_FORWARD_NAME_MAX, buildManagedVipServiceName, buildManagedVipAddressName } from '../../utils/vipName.ts';
import { findPortConflict, portConflictMessage } from '../../utils/portEndpoints.ts';
import { normalizeIpv4 } from '../../utils/publicIpPools.ts';
import { checkPublicIpUsage, describeAssignmentProvisioning } from '../../utils/publicIpAccess.ts';
import { blockedErrorText, blockedStatus } from '../../utils/portForwardTargets.ts';
import { getWorkflowBundle } from '../../workflows/store.ts';
import { runBundle, buildFirewallContext, teardownArtifacts, ProvisioningTargetGoneError, WorkflowDisabledError } from '../../workflows/runner.ts';
import { isArtifactGone } from '../../workflows/engine.ts';
import { deriveSubnet } from '../../workflows/subnet.ts';
import {
  buildPortSpecificCustomVipName,
  getRootClient,
  getScopedFirewallSyncs,
  getScopedPortForwardTargets,
  joinSequenceGroup,
  managedVipAddressMatches,
  managedVipServiceMatches,
  normalizePortForwardProtocol,
  parsePortForwardPort,
  portForwardGroupLabel,
  regroupAdjacent,
} from './portForwardHelpers.ts';
import { canManageAllPortForwards, pFirewalls, pPortForwards, pVlans } from './shared.ts';
import { insertForwardIfVlanSynced, previewSyncSubnet, trackProvisioned } from './vlanHelpers.ts';

const router = Router();

// One-shot cleanup to the current grouping scheme, then make each group
// contiguous. Root VDOM: only portal-managed port-forward policies, grouped
// per owning user. Lab VDOM: EVERY policy whose source is a synced VLAN
// interface joins that VLAN's group (manual ones included — grouping by
// source interface is the whole point); port-forward legs (srcintf = the
// inter-VDOM link) group per destination VLAN. Relative order WITHIN a group
// is preserved; a policy outside any group can end up crossed by group
// members consolidating past it — review custom deny rules after running.
router.post('/firewalls/:id/regroup-policies', pFirewalls, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const client = createClient(fw);
    const rootVdom = fw.root_vdom || 'root';
    const labVdom = fw.vdom || 'lab';
    const summary = { rootRelabeled: 0, rootMoved: 0, labRelabeled: 0, labMoved: 0, warnings: [] };

    // ── Root VDOM: port forwards grouped per owning user ─────────────────────
    const managed = await db.select().from(managedVips).where(eq(managedVips.firewall_id, fw.id));
    const desiredRootLabels = new Map(); // policyid → label
    for (const vip of managed) {
      if (!vip.policy_id) continue;
      desiredRootLabels.set(String(vip.policy_id), await portForwardGroupLabel(null, vip.mapped_ip));
    }
    const rootLabelFor = (p) => desiredRootLabels.get(String(p.policyid)) || null;

    const rootResult = await regroupAdjacent(client, rootVdom, rootLabelFor, summary.warnings);
    summary.rootRelabeled = rootResult.relabeled;
    summary.rootMoved = rootResult.moved;

    // ── Lab VDOM: VLAN policies grouped per source interface ─────────────────
    const syncs = await db.select({
      interface_name: firewallVlanSync.interface_name, vlan_name: vlans.name,
    }).from(firewallVlanSync)
      .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
      .where(eq(firewallVlanSync.firewall_id, fw.id));
    const ifaceLabels = new Map(syncs.map((s) => [s.interface_name, `${s.vlan_name} (${s.interface_name})`]));
    const labLabelFor = (p) => {
      const src = (p.srcintf || [])[0]?.name || '';
      const dst = (p.dstintf || [])[0]?.name || '';
      if (ifaceLabels.has(src)) return ifaceLabels.get(src);
      // Port-forward legs enter through the inter-VDOM link — group per target VLAN
      if (ifaceLabels.has(dst) && String(p.name || '').startsWith('PF: ')) return `Port Forwarding (${dst})`;
      return null;
    };

    const labResult = await regroupAdjacent(client, labVdom, labLabelFor, summary.warnings);
    summary.labRelabeled = labResult.relabeled;
    summary.labMoved = labResult.moved;

    await logAudit(req, 'admin_regroup_policies', fw.name,
      `root: ${summary.rootRelabeled} relabeled/${summary.rootMoved} moved; lab: ${summary.labRelabeled} relabeled/${summary.labMoved} moved${summary.warnings.length ? `; ${summary.warnings.length} warnings` : ''}`);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Update WAN config (external IP + WAN zone) from the port forwarding page
router.put('/firewalls/:id/wan-config', pFirewalls, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  const { externalIp, rootWanZone } = req.body;
  await db.update(firewalls).set({
    external_ip: externalIp ?? fw.external_ip ?? '', root_wan_zone: rootWanZone ?? fw.root_wan_zone ?? 'underlay',
  }).where(eq(firewalls.id, Number(req.params.id)));
  await logAudit(req, 'admin_update_wan_config', fw.name, `extIp=${externalIp} wanZone=${rootWanZone}`);
  res.json({ ok: true });
});

// List all VIPs from root VDOM with managed/unmanaged status
router.get('/firewalls/:id/vips', pPortForwards, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const { client, rootVdom } = getRootClient(fw);
    const allVips = await client.getVips(rootVdom);
    const unrestricted = await canManageAllPortForwards(req);
    const managedRows = await db.select({ vip_name: managedVips.vip_name, vlan_interface: managedVips.vlan_interface })
      .from(managedVips).where(eq(managedVips.firewall_id, fw.id));
    const managedMap = new Map(managedRows.map(row => [row.vip_name, row]));
    const allowedInterfaces = unrestricted
      ? null
      : new Set((await getScopedFirewallSyncs(req.session.userId, fw.id, false)).map(sync => sync.interface_name));

    const vips = allVips
      .filter(v => {
        if (v.portforward !== 'enable') return false;
        if (unrestricted) return true;
        const managed = managedMap.get(v.name);
        return !!(managed?.vlan_interface && allowedInterfaces.has(managed.vlan_interface));
      })
      .map(v => {
        const managed = managedMap.get(v.name);
        const mappedIp = (v.mappedip || []).map(m => {
          const r = m.range || '';
          return r.includes('-') ? r.split('-')[0] : r;
        }).join(', ');
        return {
          name: v.name,
          extip: v.extip || '',
          extport: v.extport || '',
          mappedip: mappedIp,
          mappedport: v.mappedport || '',
          protocol: v.protocol || 'tcp',
          extintf: v.extintf || 'any',
          managed: !!managed,
        };
      });
    res.json(vips);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Root VDOM interfaces for destination zone dropdown
router.get('/firewalls/:id/root-interfaces', pFirewalls, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const { client, rootVdom } = getRootClient(fw);
    const interfaces = await client.getInterfaces(rootVdom);
    const wanZone = fw.root_wan_zone || 'underlay';
    const skipTypes = ['tunnel', 'loopback'];
    const skipNames = ['npu', 'ha', 'mgmt', 'modem', 'ssl.', 'fortilink'];

    const filtered = interfaces
      .filter(i => {
        if (i.name === wanZone) return false; // exclude the WAN interface itself
        if (skipTypes.some(t => (i.type || '').includes(t))) return false;
        if (skipNames.some(s => (i.name || '').toLowerCase().startsWith(s))) return false;
        return true;
      })
      .map(i => ({
        name: i.name,
        type: i.type || '',
        ip: i.ip || '',
        vdom: i.vdom || '',
        description: i.description || i.alias || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Root VDOM address objects + groups for source restriction dropdown
router.get('/firewalls/:id/root-addresses', pFirewalls, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const { client, rootVdom } = getRootClient(fw);
    const [addresses, groups] = await Promise.all([
      client.getAddressObjects(rootVdom),
      client.getAddressGroups(rootVdom),
    ]);
    res.json({
      addresses: addresses.map(a => ({ name: a.name, type: a.type, subnet: a.subnet || '' })),
      groups: groups.map(g => ({ name: g.name, members: (g.member || []).map(m => m.name) })),
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// VM targets for port forwarding — returns VMs with their SSH IPs, VLAN tags, and resolved interfaces
router.get('/firewalls/:id/vm-targets', pPortForwards, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const targets = await getScopedPortForwardTargets(req, fw);
    res.json({ targets });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Create a new port forward (VIP + firewall policy in root VDOM)
router.post('/firewalls/:id/vips', pPortForwards, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  let { name, protocol = 'tcp', extPort, mappedIp, mappedPort, dstInterface, vlanInterface, srcAddresses = ['all'], node, vmid } = req.body;
  // Which public endpoint to publish on. Omitted / null keeps the historical
  // behavior: the firewall's default WAN address. Only the *id* is accepted —
  // the address, interface and gateway are always resolved server-side from the
  // stored pool, never taken from the client.
  const publicIpId = req.body.publicIpId ?? req.body.public_ip_id ?? null;
  const unrestricted = await canManageAllPortForwards(req);
  protocol = normalizePortForwardProtocol(protocol);
  extPort = parsePortForwardPort(extPort);
  mappedPort = parsePortForwardPort(mappedPort);
  name = String(name || '').trim();

  if (!protocol) {
    return res.status(400).json({ error: 'protocol must be tcp or udp' });
  }
  if (!name || !extPort || !mappedPort) {
    return res.status(400).json({ error: 'name, extPort, and mappedPort are required; ports must be between 1 and 65535' });
  }
  name = buildPortSpecificCustomVipName(name, protocol, mappedPort);
  // Enforce FortiGate's object-name limit server-side, even if a client submits
  // an overlong name. Bounded to PORT_FORWARD_NAME_MAX (not 35) so the derived
  // "PF: <name>" policy name also stays within the 35-char cap. Matches the
  // frontend preview (frontend/src/utils/vipName.js) exactly.
  name = shortenVipName(name, PORT_FORWARD_NAME_MAX);

  const serviceName = buildManagedVipServiceName(name, protocol, mappedPort);
  let policyId = null;
  let labPolicyId = null;
  let labAddressName = '';

  try {
    if (!unrestricted) {
      if (!node || !vmid) {
        return res.status(400).json({ error: 'node and vmid are required for scoped port forwards' });
      }

      const targets = await getScopedPortForwardTargets(req, fw);
      const target = targets.find(t => (t.nodeRef || t.node) === node && String(t.vmid) === String(vmid));
      if (!target) {
        return res.status(403).json({ error: 'You can only create port forwards for VMs assigned to you' });
      }
      // Report the specific missing prerequisite rather than a generic "not on a
      // VLAN you can publish through" — the user cannot act on the generic one.
      if (!target.eligible) {
        const blocked = target.blocked;
        return res.status(blockedStatus(blocked)).json({
          error: blockedErrorText(blocked) || 'This VM is not on a VLAN you can publish through this firewall',
          blocked: blocked || null,
        });
      }

      mappedIp = target.ip;
      dstInterface = target.dstInterface;
      vlanInterface = target.vlanInterface;
      srcAddresses = ['all'];
    }

    if (!mappedIp || !dstInterface) {
      return res.status(400).json({ error: 'mappedIp and dstInterface are required' });
    }

    const [duplicateMappedPort] = await db.select({ vip_name: managedVips.vip_name }).from(managedVips)
      .where(and(eq(managedVips.firewall_id, fw.id), eq(managedVips.mapped_ip, mappedIp),
        eq(managedVips.mapped_port, mappedPort), eq(managedVips.protocol, protocol))).limit(1);
    if (duplicateMappedPort) {
      return res.status(409).json({
        error: `Internal port ${mappedIp}:${mappedPort}/${protocol.toUpperCase()} is already published by "${duplicateMappedPort.vip_name}"`
      });
    }

    // Resolve the public endpoint. Everything the firewall needs — the external
    // address and the interface it arrives on — comes out of the stored pool;
    // the request only ever names an id, so a non-admin cannot publish onto an
    // address (or an interface) that was not handed to them.
    let publicIp = null;
    let publicPool = null;
    let publicAssignment = null;
    if (publicIpId !== null && publicIpId !== undefined && publicIpId !== '') {
      publicIp = (await db.select().from(publicIps)
        .where(and(eq(publicIps.id, Number(publicIpId)), eq(publicIps.firewall_id, fw.id))).limit(1))[0] || null;
      publicPool = publicIp ? (await db.select().from(publicIpPools).where(eq(publicIpPools.id, publicIp.pool_id)).limit(1))[0] || null : null;
      publicAssignment = publicIp
        ? (await db.select().from(publicIpAssignments).where(eq(publicIpAssignments.public_ip_id, publicIp.id)).limit(1))[0] || null
        : null;
      const denial = checkPublicIpUsage({
        isAdmin: req.session.isAdmin,
        unrestricted,
        userId: req.session.userId,
        publicIp,
        pool: publicPool,
        assignment: publicAssignment,
        target: { mappedIp, vmid },
      });
      if (denial) return res.status(denial.status).json({ error: denial.error });
    }

    const externalIp = publicIp ? publicIp.address : (fw.external_ip || '');
    if (!externalIp) {
      return res.status(400).json({ error: 'Firewall has no external IP configured. Set it in WAN config first.' });
    }

    labAddressName = vlanInterface ? buildManagedVipAddressName(name, mappedIp) : '';
    const { client, rootVdom } = getRootClient(fw);
    // Inbound traffic for a dedicated address arrives on the pool's transit
    // interface, not on the shared WAN zone.
    const wanZone = publicPool?.external_interface || fw.root_wan_zone || 'underlay';
    const labVdom = fw.vdom || 'lab';

    // Endpoint-aware external-port conflict check. The boundary is
    // firewall + public endpoint + protocol + overlapping port range, so two
    // users may both publish 443/tcp as long as they sit on different public
    // addresses — while two forwards on the SAME address still collide.
    const candidateEndpoint = {
      firewallId: fw.id,
      publicIpId: publicIp?.id ?? null,
      address: externalIp,
      protocol,
      port: extPort,
      label: name,
    };

    // Managed forwards first: the portal's own records give the friendliest
    // error and stay correct even when FortiGate is temporarily unreachable.
    const managedEndpoints = (await db.select({
      vip_name: managedVips.vip_name, protocol: managedVips.protocol, ext_port: managedVips.ext_port,
      public_ip_id: managedVips.public_ip_id, public_address: publicIps.address,
    }).from(managedVips)
      .leftJoin(publicIps, eq(publicIps.id, managedVips.public_ip_id))
      .where(eq(managedVips.firewall_id, fw.id))).map(row => ({
      firewallId: fw.id,
      publicIpId: row.public_ip_id,
      // A NULL public_ip_id still means the default WAN endpoint.
      address: row.public_address || (row.public_ip_id ? '' : (fw.external_ip || '')),
      protocol: row.protocol,
      port: row.ext_port,
      label: row.vip_name,
    }));
    const managedConflict = findPortConflict(managedEndpoints, candidateEndpoint);
    if (managedConflict) {
      return res.status(409).json({ error: portConflictMessage(managedConflict) });
    }

    // Then everything live on the box, including VIPs nobody here created.
    // A VIP whose extip cannot be read as an address (or is the catch-all
    // 0.0.0.0) is attributed to the default WAN endpoint, which is where such a
    // rule actually listens — that keeps the legacy check as strict as it was.
    const allVips = await client.getVips(rootVdom);
    const liveEndpoints = allVips
      .filter(v => v.portforward === 'enable')
      .map(v => {
        const extip = normalizeIpv4(v.extip);
        return {
          firewallId: fw.id,
          address: !extip || extip === '0.0.0.0' ? (fw.external_ip || '') : extip,
          protocol: v.protocol || 'tcp',
          port: v.extport,
          label: v.name,
        };
      });
    const liveConflict = findPortConflict(liveEndpoints, candidateEndpoint);
    if (liveConflict) {
      return res.status(409).json({ error: portConflictMessage(liveConflict) });
    }

    // Check for duplicate VIP name
    const existingVip = await client.getVip(name, rootVdom);
    if (existingVip) {
      return res.status(409).json({ error: `A VIP named "${name}" already exists` });
    }

    const existingService = await client.getServiceObject(serviceName, rootVdom);
    if (existingService && !managedVipServiceMatches(existingService, protocol, mappedPort)) {
      return res.status(409).json({ error: `A managed service object named "${serviceName}" already exists with different port settings` });
    }

    if (vlanInterface) {
      const existingLabService = await client.getServiceObject(serviceName, labVdom);
      if (existingLabService && !managedVipServiceMatches(existingLabService, protocol, mappedPort)) {
        return res.status(409).json({ error: `A lab VDOM service object named "${serviceName}" already exists with different port settings` });
      }

      const existingLabAddress = await client.getAddressObject(labAddressName, labVdom);
      if (existingLabAddress && !managedVipAddressMatches(existingLabAddress, mappedIp)) {
        return res.status(409).json({ error: `A lab VDOM address object named "${labAddressName}" already exists with a different IP` });
      }
    }

    // Object creation (service objects, VIP, and the inbound policy chain) runs
    // through the configurable workflow engine. The seeded default
    // `port_forward_create` workflow reproduces the historical sequence exactly;
    // the engine records each created object and rolls back in reverse on failure.
    const bundle = await getWorkflowBundle(fw.id, 'port_forward_create');
    if (!bundle) throw new Error(`Port-forward workflow is unavailable for firewall ${fw.name}`);
    const context = {
      name,
      protocol,
      externalPort: extPort,
      internalIp: mappedIp,
      internalPort: mappedPort,
      dstInterface,
      vlanInterface: vlanInterface || '',
      srcAddresses,
      serviceName,
      labAddressName,
      externalIp,
      wanZone,
      rootVdom,
      labVdom,
      labSrcInterface: fw.lab_vdom_link || 'lab-root0',
      firewall: buildFirewallContext(fw),
    };
    const { runId, outputs, artifacts } = await runBundle({
      bundle, context, client, firewall: fw,
      subjectType: 'port_forward', subjectId: name, subjectLabel: name,
      requestId: req.requestId || '',
    });
    policyId = outputs.policy_root?.policyId ?? null;
    labPolicyId = outputs.policy_lab?.policyId ?? null;

    // Grouping: one sequence group per owning user in the root VDOM, and the
    // target VLAN's port-forward group in the lab VDOM. The workflow engine
    // appends policies at the bottom with a default label, so park them
    // afterwards — cosmetic, never fails the port forward.
    await joinSequenceGroup(client, policyId, await portForwardGroupLabel(vmid, mappedIp), rootVdom);
    if (vlanInterface) {
      await joinSequenceGroup(client, labPolicyId, `Port Forwarding (${vlanInterface})`, labVdom);
    }

    // Track in DB (with recorded artifacts for artifact-based teardown on delete).
    // artifacts is a jsonb column — pass the object directly.
    await trackProvisioned(client, artifacts, () => insertForwardIfVlanSynced(fw.id, vlanInterface, {
      firewall_id: fw.id, vip_name: name, policy_id: policyId, service_name: serviceName, protocol,
      ext_port: extPort, mapped_ip: mappedIp, mapped_port: mappedPort, dst_interface: dstInterface,
      lab_policy_id: labPolicyId, vlan_interface: vlanInterface || '', artifacts, workflow_run_id: runId,
      public_ip_id: publicIp?.id ?? null,
    }));

    await logAudit(req, 'admin_create_port_forward', name, `${protocol}/${externalIp}:${extPort} → ${mappedIp}:${mappedPort} via ${dstInterface}/${vlanInterface}`);
    res.json({
      ok: true, vipName: name, policyId, labPolicyId, serviceName, externalIp,
      publicIpId: publicIp?.id ?? null,
      // A dedicated address only has its inbound VIP built here. The egress
      // path that makes replies leave through the same transit interface is
      // provisioned by a workflow that does not exist yet — say so instead of
      // letting the caller assume the forward is complete.
      publicIpProvisioning: publicAssignment
        ? describeAssignmentProvisioning(publicAssignment.status)
        : null,
    });
  } catch (err) {
    if (err instanceof ProvisioningTargetGoneError) return res.status(err.status).json({ error: sanitizeError(err.message) });
    if (err instanceof WorkflowDisabledError) return res.status(err.status).json({ error: err.message });
    // The engine already rolled back anything it created on failure.
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Delete a managed port forward (VIP + policy)
router.delete('/firewalls/:id/vips/:name', pPortForwards, async (req, res) => {
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(req.params.id))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  const vipName = req.params.name;
  const [managed] = await db.select().from(managedVips)
    .where(and(eq(managedVips.firewall_id, fw.id), eq(managedVips.vip_name, vipName))).limit(1);
  if (!managed) {
    return res.status(403).json({ error: 'Cannot delete unmanaged VIPs. This was not created through VM Manager.' });
  }
  if (!await canManageAllPortForwards(req)) {
    const allowedInterfaces = new Set((await getScopedFirewallSyncs(req.session.userId, fw.id, false)).map(sync => sync.interface_name));
    if (!managed.vlan_interface || !allowedInterfaces.has(managed.vlan_interface)) {
      return res.status(403).json({ error: 'You do not have access to this port forward' });
    }
  }

  try {
    const { client, rootVdom } = getRootClient(fw);

    if (managed.artifacts) {
      const teardownRes = await teardownArtifacts(client, managed.artifacts);
      if (teardownRes.errors && teardownRes.errors.length > 0) {
        console.warn(`[vip-delete] Teardown incomplete for VIP ${vipName} on ${fw.name}:`, teardownRes.errors);
        await logAudit(
          req,
          'admin_delete_port_forward_failed',
          vipName,
          `Firewall ${fw.name} teardown failed: ${teardownRes.errors.join('; ')}`
        );
        return res.status(502).json({
          error: `Failed to remove port forward from firewall: ${teardownRes.errors.map(sanitizeError).join('; ')}`,
          errors: teardownRes.errors.map(sanitizeError),
          details: teardownRes.errors.map(sanitizeError),
        });
      }
    } else {
      // Legacy row (created before the workflow engine) — original delete path.
      // Delete lab VDOM policy first
      if (managed.lab_policy_id) {
        const labVdom = fw.vdom || 'lab';
        try { await client.deletePolicy(managed.lab_policy_id, labVdom); }
        catch (e) { console.warn(`[vip-delete] Lab policy ${managed.lab_policy_id} delete warning:`, e.message); }
      }

      // Delete root VDOM policy (VIP can't be deleted while referenced by a policy)
      if (managed.policy_id) {
        try { await client.deletePolicy(managed.policy_id, rootVdom); }
        catch (e) { console.warn(`[vip-delete] Policy ${managed.policy_id} delete warning:`, e.message); }
      }

      // Also search for any other policies referencing this VIP (stale ID safety)
      try {
        const policies = await client.getPolicies(rootVdom);
        const refs = policies.filter(p =>
          (p.dstaddr || []).some(a => a.name === vipName) &&
          String(p.policyid) !== String(managed.policy_id)
        );
        for (const p of refs) {
          try { await client.deletePolicy(p.policyid, rootVdom); }
          catch (e) { console.warn(`[vip-delete] Extra policy ${p.policyid} warning:`, e.message); }
        }
      } catch (e) { console.warn(`[vip-delete] Policy search warning:`, e.message); }

      // Delete VIP — already gone upstream counts as deleted, so a stale record can be cleared.
      try { await client.deleteVip(vipName, rootVdom); }
      catch (e) { if (!isArtifactGone(e)) throw e; }

      if (managed.service_name) {
        try {
          await client.deleteServiceObject(managed.service_name, rootVdom);
        } catch (e) {
          console.warn(`[vip-delete] Service ${managed.service_name} warning:`, e.message);
        }
        if (managed.vlan_interface) {
          const labVdom = fw.vdom || 'lab';
          try {
            await client.deleteServiceObject(managed.service_name, labVdom);
          } catch (e) {
            console.warn(`[vip-delete] Lab service ${managed.service_name} warning:`, e.message);
          }
        }
      }

      if (managed.vlan_interface) {
        const labVdom = fw.vdom || 'lab';
        const labAddressName = buildManagedVipAddressName(managed.vip_name, managed.mapped_ip);
        try {
          await client.deleteAddressObject(labAddressName, labVdom);
        } catch (e) {
          console.warn(`[vip-delete] Lab address ${labAddressName} warning:`, e.message);
        }
      }
    }

    // Remove from DB
    await db.delete(managedVips).where(and(eq(managedVips.firewall_id, fw.id), eq(managedVips.vip_name, vipName)));

    await logAudit(req, 'admin_delete_port_forward', vipName, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Helper: compute subnet for a VLAN tag (optionally on a given firewall's scheme)
router.get('/vlans/subnet/:tag', pVlans, async (req, res) => {
  const tag = parseInt(req.params.tag);
  if (!deriveSubnet(tag, {})) return res.status(400).json({ error: 'Invalid tag for auto IP scheme' });
  if (req.query.firewallId === undefined) return res.json(deriveSubnet(tag, {}));
  // With ?firewallId=: what a sync to that firewall would provision and record.
  const firewallId = Number(req.query.firewallId);
  if (!Number.isInteger(firewallId) || firewallId <= 0) return res.status(400).json({ error: 'Invalid firewallId' });
  const [fw] = await db.select().from(firewalls).where(eq(firewalls.id, firewallId)).limit(1);
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const subnet = await previewSyncSubnet(fw, tag);
    if (!subnet) return res.status(400).json({ error: 'Invalid tag for this firewall\'s IP scheme' });
    res.json(subnet);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
