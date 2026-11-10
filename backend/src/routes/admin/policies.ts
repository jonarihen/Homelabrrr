import { Router } from 'express';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vlans, userVlans, firewalls, firewallVlanSync } from '../../db/schema/index.ts';
import { createClient } from '../../fortigate.ts';
import { requireAdmin } from '../../middleware/auth.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { logAudit } from '../../utils/audit.ts';
import { getWorkflowBundle } from '../../workflows/store.ts';
import { runBundle, buildFirewallContext, WorkflowDisabledError, assertWorkflowEnabled } from '../../workflows/runner.ts';
import { syncedSubnet } from '../../workflows/subnet.ts';
import { joinSequenceGroup } from './portForwardHelpers.ts';
import { pPolicies, userOwnsVlan } from './shared.ts';

const router = Router();

// ─── Policy Engine ──────────────────────────────────────────────────────────

router.get('/policies', pPolicies, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });

  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const client = createClient(fw);
    const allPolicies = await client.getPolicies();

    // Get synced VLANs for this firewall (non-admins only see their assigned VLANs)
    const isAdmin = req.session.isAdmin;
    const syncCols = {
      interface_name: firewallVlanSync.interface_name,
      vlan_id: vlans.id, vlan_name: vlans.name, vlan_tag: vlans.tag,
    };
    const syncs = isAdmin
      ? await db.select(syncCols).from(firewallVlanSync)
          .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
          .where(eq(firewallVlanSync.firewall_id, Number(firewallId)))
      : await db.select(syncCols).from(firewallVlanSync)
          .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
          .innerJoin(userVlans, and(eq(userVlans.vlan_id, vlans.id), eq(userVlans.user_id, req.session.userId)))
          .where(eq(firewallVlanSync.firewall_id, Number(firewallId)));
    const vlanInterfaces = new Set(syncs.map(s => s.interface_name));
    const vlanMap = {};
    syncs.forEach(s => { vlanMap[s.interface_name] = s; });

    // Filter to policies involving synced VLANs
    const policies = allPolicies
      .filter(p => {
        const srcs = (p.srcintf || []).map(i => i.name);
        return srcs.some(s => vlanInterfaces.has(s));
      })
      .map(p => {
        const srcName = (p.srcintf || [])[0]?.name || '';
        const dstName = (p.dstintf || [])[0]?.name || '';
        const srcVlan = vlanMap[srcName] || null;
        const dstVlan = vlanMap[dstName] || null;
        const isInternet = dstName === (fw.lab_vdom_link || 'lab-root0');
        return {
          policyid: p.policyid,
          name: p.name,
          srcintf: srcName,
          dstintf: dstName,
          srcaddr: (p.srcaddr || []).map(a => a.name),
          dstaddr: (p.dstaddr || []).map(a => a.name),
          service: (p.service || []).map(s => s.name),
          action: p.action,
          logtraffic: p.logtraffic,
          globalLabel: p['global-label'] || '',
          comments: p.comments || '',
          isInternet,
          srcVlan: srcVlan ? { id: srcVlan.vlan_id, name: srcVlan.vlan_name, tag: srcVlan.vlan_tag } : null,
          dstVlan: dstVlan ? { id: dstVlan.vlan_id, name: dstVlan.vlan_name, tag: dstVlan.vlan_tag } : null,
        };
      });

    res.json(policies);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/policies', pPolicies, async (req, res) => {
  const { firewallId, srcVlanTag, dstVlanTag, services = ['ALL'], action = 'accept', bidirectional = false } = req.body;
  if (!firewallId || !srcVlanTag || !dstVlanTag) {
    return res.status(400).json({ error: 'firewallId, srcVlanTag, and dstVlanTag are required' });
  }
  if (srcVlanTag === dstVlanTag) {
    return res.status(400).json({ error: 'Source and destination VLANs must be different' });
  }

  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  // Resolve VLANs
  const vlanWithIfaceCols = {
    ...getTableColumns(vlans), interface_name: firewallVlanSync.interface_name, synced_cidr: firewallVlanSync.subnet_cidr,
  };
  const [srcVlan] = await db.select(vlanWithIfaceCols).from(vlans)
    .innerJoin(firewallVlanSync, eq(firewallVlanSync.vlan_id, vlans.id))
    .where(and(eq(vlans.tag, Number(srcVlanTag)), eq(firewallVlanSync.firewall_id, Number(firewallId)))).limit(1);
  const [dstVlan] = await db.select(vlanWithIfaceCols).from(vlans)
    .innerJoin(firewallVlanSync, eq(firewallVlanSync.vlan_id, vlans.id))
    .where(and(eq(vlans.tag, Number(dstVlanTag)), eq(firewallVlanSync.firewall_id, Number(firewallId)))).limit(1);
  if (!srcVlan) return res.status(400).json({ error: `Source VLAN ${srcVlanTag} not synced to this firewall` });
  if (!dstVlan) return res.status(400).json({ error: `Destination VLAN ${dstVlanTag} not synced to this firewall` });

  // Non-admins must have both VLANs assigned to them
  if (!req.session.isAdmin) {
    const hasSrc = await userOwnsVlan(req.session.userId, srcVlan.id);
    const hasDst = await userOwnsVlan(req.session.userId, dstVlan.id);
    if (!hasSrc) return res.status(403).json({ error: `You do not have access to source VLAN ${srcVlanTag}` });
    if (!hasDst) return res.status(403).json({ error: `You do not have access to destination VLAN ${dstVlanTag}` });
  }

  // Address the networks these syncs actually provisioned on this firewall.
  const srcSubnet = syncedSubnet(srcVlan.tag, srcVlan.synced_cidr);
  const dstSubnet = syncedSubnet(dstVlan.tag, dstVlan.synced_cidr);
  if (!srcSubnet || !dstSubnet) return res.status(400).json({ error: 'Cannot derive subnets from VLAN tags' });

  const srcAddrName = `NET-${srcSubnet.networkIp}_24`;
  const dstAddrName = `NET-${dstSubnet.networkIp}_24`;

  try {
    const client = createClient(fw);

    // Policy creation runs through the configurable workflow engine. The seeded
    // default `policy_create` workflow reproduces the forward/reverse policy
    // shapes exactly; the engine rolls back the forward policy if the reverse
    // one fails. Resolved first so a disabled workflow is refused before the
    // address objects below touch the firewall.
    const bundle = await getWorkflowBundle(fw.id, 'policy_create');
    if (!bundle) throw new Error(`Policy creation workflow is unavailable for firewall ${fw.name}`);
    assertWorkflowEnabled(bundle.workflow);

    // Ensure address objects exist
    for (const [name, subnet] of [[srcAddrName, srcSubnet], [dstAddrName, dstSubnet]]) {
      if (!await client.getAddressObject(name)) {
        await client.createAddressObject(name, `${subnet.networkIp} ${subnet.netmask}`);
      }
    }

    // Check for duplicate policy
    const existing = await client.getPolicies();
    const dup = existing.find(p =>
      (p.srcintf || []).some(i => i.name === srcVlan.interface_name) &&
      (p.dstintf || []).some(i => i.name === dstVlan.interface_name)
    );
    if (dup) return res.status(409).json({ error: `Policy from ${srcVlan.interface_name} to ${dstVlan.interface_name} already exists (id: ${dup.policyid})` });

    // The reverse policy is only created when bidirectional AND it doesn't
    // already exist — decide here, then let the workflow's conditional step run.
    let doReverse = false;
    if (bidirectional) {
      const revDup = existing.find(p =>
        (p.srcintf || []).some(i => i.name === dstVlan.interface_name) &&
        (p.dstintf || []).some(i => i.name === srcVlan.interface_name)
      );
      doReverse = !revDup;
    }

    const context = {
      action,
      bidirectional: doReverse,
      services,
      srcVlan: { interface_name: srcVlan.interface_name, name: srcVlan.name, tag: srcVlan.tag },
      dstVlan: { interface_name: dstVlan.interface_name, name: dstVlan.name, tag: dstVlan.tag },
      srcAddrName,
      dstAddrName,
      firewall: buildFirewallContext(fw),
    };
    const { outputs } = await runBundle({
      bundle, context, client, firewall: fw,
      subjectType: 'policy', subjectId: `${srcVlan.interface_name}->${dstVlan.interface_name}`,
      subjectLabel: `${srcVlan.interface_name} → ${dstVlan.interface_name}`,
      requestId: req.requestId || '',
    });
    const policyIds = [outputs.forward?.policyId, outputs.reverse?.policyId].filter((v) => v !== undefined && v !== null);

    // Keep every policy inside its source VLAN's sequence group — the workflow
    // appends new policies at the bottom, which fragments the GUI grouping
    await joinSequenceGroup(client, outputs.forward?.policyId, `${srcVlan.name} (${srcVlan.interface_name})`);
    await joinSequenceGroup(client, outputs.reverse?.policyId, `${dstVlan.name} (${dstVlan.interface_name})`);

    await logAudit(req, 'admin_create_policy', `${srcVlan.interface_name} → ${dstVlan.interface_name}`, `services: ${services.join(',')} action: ${action}${bidirectional ? ' (bidirectional)' : ''}`);
    res.json({ policyIds });
  } catch (err) {
    if (err instanceof WorkflowDisabledError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/policies/:policyId', pPolicies, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });

  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });

  try {
    const client = createClient(fw);

    // Non-admins can only delete policies involving their assigned VLANs
    if (!req.session.isAdmin) {
      const policy = await client.getPolicy(req.params.policyId);
      if (policy) {
        const policyIntfs = [
          ...((policy.srcintf || []).map(i => i.name)),
          ...((policy.dstintf || []).map(i => i.name)),
        ];
        // Get user's VLAN interfaces on this firewall
        const userSyncs = await db.select({ interface_name: firewallVlanSync.interface_name }).from(firewallVlanSync)
          .innerJoin(userVlans, and(eq(userVlans.vlan_id, firewallVlanSync.vlan_id), eq(userVlans.user_id, req.session.userId)))
          .where(eq(firewallVlanSync.firewall_id, Number(firewallId)));
        const userIntfs = new Set(userSyncs.map(s => s.interface_name));
        const hasAccess = policyIntfs.some(i => userIntfs.has(i));
        if (!hasAccess) {
          return res.status(403).json({ error: 'You do not have access to the VLANs in this policy' });
        }
      }
    }

    await client.deletePolicy(req.params.policyId);
    await logAudit(req, 'admin_delete_policy', `Policy ${req.params.policyId}`, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Address & Service Objects ──────────────────────────────────────────────

router.get('/objects/addresses', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const objects = await client.getAddressObjects();
    res.json(objects.map(o => ({
      name: o.name,
      type: o.type,
      subnet: o.subnet,
      fqdn: o.fqdn || '',
      comment: o.comment || '',
      color: o.color || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/objects/addresses', requireAdmin, async (req, res) => {
  const { firewallId, name, type = 'ipmask', subnet, fqdn, comment } = req.body;
  if (!firewallId || !name) return res.status(400).json({ error: 'firewallId and name required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = { name, type };
    if (type === 'ipmask' && subnet) data.subnet = subnet;
    if (type === 'fqdn' && fqdn) data.fqdn = fqdn;
    if (comment) data.comment = comment;
    await client.createAddressObject(data);
    await logAudit(req, 'admin_create_address_object', name, `type=${type} ${subnet || fqdn || ''}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/objects/addresses/:name', requireAdmin, async (req, res) => {
  const { firewallId, subnet, fqdn, comment } = req.body;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = {};
    if (subnet) data.subnet = subnet;
    if (fqdn) data.fqdn = fqdn;
    if (comment !== undefined) data.comment = comment;
    await client.updateAddressObject(req.params.name, data);
    await logAudit(req, 'admin_update_address_object', req.params.name, JSON.stringify(data));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/objects/addresses/:name', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    await client.deleteAddressObject(req.params.name);
    await logAudit(req, 'admin_delete_address_object', req.params.name, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.get('/objects/services', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const objects = await client.getServiceObjects();
    res.json(objects.map(o => ({
      name: o.name,
      protocol: o.protocol,
      tcpPortrange: o['tcp-portrange'] || '',
      udpPortrange: o['udp-portrange'] || '',
      comment: o.comment || '',
      color: o.color || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/objects/services', requireAdmin, async (req, res) => {
  const { firewallId, name, protocol = 'TCP/UDP/SCTP', tcpPortrange, udpPortrange, comment } = req.body;
  if (!firewallId || !name) return res.status(400).json({ error: 'firewallId and name required' });
  if (!tcpPortrange && !udpPortrange) return res.status(400).json({ error: 'At least one port range required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    const data = { name, protocol };
    if (tcpPortrange) data['tcp-portrange'] = tcpPortrange;
    if (udpPortrange) data['udp-portrange'] = udpPortrange;
    if (comment) data.comment = comment;
    await client.createServiceObject(data);
    await logAudit(req, 'admin_create_service_object', name, `tcp=${tcpPortrange || ''} udp=${udpPortrange || ''}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/objects/services/:name', requireAdmin, async (req, res) => {
  const { firewallId } = req.query;
  if (!firewallId) return res.status(400).json({ error: 'firewallId required' });
  const fw = (await db.select().from(firewalls).where(eq(firewalls.id, Number(firewallId))).limit(1))[0];
  if (!fw) return res.status(404).json({ error: 'Firewall not found' });
  try {
    const client = createClient(fw);
    await client.deleteServiceObject(req.params.name);
    await logAudit(req, 'admin_delete_service_object', req.params.name, `Firewall: ${fw.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
