import { Router } from 'express';
import { and, eq, count } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vmAssignments, vlans, userVlans, firewalls, firewallVlanSync } from '../../db/schema/index.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import { createClient } from '../../fortigate.ts';
import { requirePermission } from '../../middleware/auth.ts';
import { logAudit } from '../../utils/audit.ts';
import { teardownArtifacts } from '../../workflows/runner.ts';
import { syncedSubnet } from '../../workflows/subnet.ts';
import { pAssignments, pVlans, serializeNodeIdentity, userOwnsVlan } from './shared.ts';
import {
  cleanupVlanPortForwards,
  deleteSyncUnlessForwarded,
  legacyForwardsNeedingReview,
  legacyReviewNote,
  legacyReviewPayload,
} from './vlanHelpers.ts';

const router = Router();

// ─── VLANs ───────────────────────────────────────────────────────────────────

async function findNextAvailableVlanTag() {
  const usedTags = new Set(
    (await db.select({ tag: vlans.tag }).from(vlans).orderBy(vlans.tag))
      .map(row => parseInt(row.tag, 10))
      .filter(Number.isInteger)
  );

  const ranges = (await db.select({ vlan_range_start: firewalls.vlan_range_start, vlan_range_end: firewalls.vlan_range_end })
    .from(firewalls).orderBy(firewalls.vlan_range_start, firewalls.vlan_range_end))
    .map(row => ({
      start: row.vlan_range_start || 1001,
      end: row.vlan_range_end || 1999,
    }));

  const pools = ranges.length > 0 ? ranges : [{ start: 1001, end: 1999 }];

  for (const pool of pools) {
    for (let tag = pool.start; tag <= pool.end; tag += 1) {
      if (!usedTags.has(tag)) return tag;
    }
  }

  return null;
}

function isValidCidr(cidr = '') {
  const trimmed = String(cidr).trim();
  if (!trimmed) return true;
  const match = trimmed.match(/^(\d{1,3})(?:\.(\d{1,3})){3}\/(\d{1,2})$/);
  if (!match) return false;
  const [ip, prefix] = trimmed.split('/');
  const inRange = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4) return false;
  if (!octets.every(octet => inRange(octet, 255))) return false;
  return inRange(Number(prefix), 32);
}


// syncedCidr: the network a firewall sync recorded (firewall_vlan_sync.subnet_cidr).
function serializeVlanSubnet(vlan, syncedCidr) {
  if (vlan.mode === 'tagged_only') {
    if (!vlan.subnet_cidr) return null;
    return {
      network: vlan.subnet_cidr,
      gateway: '',
      dhcp: '',
      custom: true,
    };
  }
  return syncedSubnet(vlan.tag, syncedCidr);
}

// VLANs read also needed by policies page and assignments page
// Non-admins only see VLANs assigned to them via user_vlans
router.get('/vlans', requirePermission('can_manage_vlans', 'can_manage_policies', 'can_manage_assignments'), async (req, res) => {
  const isAdmin = req.session.isAdmin;
  const vlanRows = isAdmin
    ? await db.select().from(vlans).orderBy(vlans.tag)
    : await db.select({
        id: vlans.id, name: vlans.name, tag: vlans.tag, mode: vlans.mode,
        subnet_cidr: vlans.subnet_cidr, description: vlans.description, created_at: vlans.created_at,
      }).from(vlans)
        .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
        .where(eq(userVlans.user_id, req.session.userId))
        .orderBy(vlans.tag);
  const syncs = await db.select({
    vlan_id: firewallVlanSync.vlan_id, firewall_id: firewallVlanSync.firewall_id,
    interface_name: firewallVlanSync.interface_name, firewall_name: firewalls.name,
    subnet_cidr: firewallVlanSync.subnet_cidr,
  }).from(firewallVlanSync).innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .orderBy(firewallVlanSync.firewall_id);
  const syncMap = {};
  syncs.forEach(s => {
    if (!syncMap[s.vlan_id]) syncMap[s.vlan_id] = [];
    syncMap[s.vlan_id].push(s);
  });
  const fwRanges = await db.select({
    id: firewalls.id, name: firewalls.name, vlan_range_start: firewalls.vlan_range_start, vlan_range_end: firewalls.vlan_range_end,
  }).from(firewalls);
  // Each sync carries the subnet it provisioned; the VLAN-level subnet is the
  // lowest-id firewall's (unsynced → default scheme).
  res.json(vlanRows.map(v => ({
    ...v,
    firewallSync: (syncMap[v.id] || []).map(s => ({
      firewallId: s.firewall_id, firewallName: s.firewall_name, interfaceName: s.interface_name,
      subnet: serializeVlanSubnet(v, s.subnet_cidr)?.network || '',
    })),
    subnet: serializeVlanSubnet(v, syncMap[v.id]?.[0]?.subnet_cidr),
    firewallRanges: fwRanges,
  })));
});

router.post('/vlans', pVlans, async (req, res) => {
  const { name, tag, description, mode = 'managed', subnetCidr = '' } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!['managed', 'tagged_only'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid VLAN mode' });
  }
  if (!req.session.isAdmin && mode !== 'managed') {
    return res.status(403).json({ error: 'Only admins can create tagged-only VLANs' });
  }

  const trimmedSubnetCidr = String(subnetCidr || '').trim();
  if (mode === 'tagged_only' && !trimmedSubnetCidr) {
    return res.status(400).json({ error: 'Subnet CIDR is required for tagged-only VLANs' });
  }
  if (mode === 'tagged_only' && !isValidCidr(trimmedSubnetCidr)) {
    return res.status(400).json({ error: 'Invalid subnet CIDR' });
  }

  let vlanTag;
  if (req.session.isAdmin) {
    if (tag === undefined) {
      return res.status(400).json({ error: 'Tag required' });
    }
    vlanTag = parseInt(tag, 10);
  } else {
    vlanTag = await findNextAvailableVlanTag();
    if (!vlanTag) {
      return res.status(409).json({ error: 'No VLAN tags are available in the configured firewall pools' });
    }
  }

  try {
    const [r] = await db.insert(vlans).values({
      name, tag: vlanTag, mode, subnet_cidr: mode === 'tagged_only' ? trimmedSubnetCidr : '', description: description || '',
    }).returning({ id: vlans.id });

    // Auto-assign to creating non-admin so they can immediately see and manage it
    if (!req.session.isAdmin) {
      await db.insert(userVlans).values({ user_id: req.session.userId, vlan_id: r.id }).onConflictDoNothing();
    }

    res.json({ id: r.id, name, tag: vlanTag, mode, subnet_cidr: mode === 'tagged_only' ? trimmedSubnetCidr : '', description: description || '' });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VLAN tag already exists' });
    }
    throw err;
  }
});

router.put('/vlans/:id', pVlans, async (req, res) => {
  const { name, tag, description, mode, subnetCidr } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const [existing] = await db.select().from(vlans).where(eq(vlans.id, Number(req.params.id))).limit(1);
  if (!existing) return res.status(404).json({ error: 'VLAN not found' });
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, existing.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const nextMode = mode || existing.mode || 'managed';
  if (!['managed', 'tagged_only'].includes(nextMode)) {
    return res.status(400).json({ error: 'Invalid VLAN mode' });
  }
  if (!req.session.isAdmin && nextMode !== existing.mode) {
    return res.status(403).json({ error: 'Only admins can change VLAN type' });
  }

  const requestedTag = tag === undefined ? existing.tag : parseInt(tag, 10);
  if (!req.session.isAdmin && requestedTag !== existing.tag) {
    return res.status(403).json({ error: 'Only admins can change VLAN tags' });
  }
  if (!req.session.isAdmin && subnetCidr !== undefined && String(subnetCidr || '').trim() !== (existing.subnet_cidr || '')) {
    return res.status(403).json({ error: 'Only admins can change VLAN subnets' });
  }

  const [{ count: syncCount }] = await db.select({ count: count() }).from(firewallVlanSync).where(eq(firewallVlanSync.vlan_id, Number(req.params.id)));
  if (syncCount > 0 && nextMode !== existing.mode) {
    return res.status(400).json({ error: 'Unsync this VLAN from firewalls before changing its type' });
  }
  if (syncCount > 0 && requestedTag !== existing.tag) {
    // The provisioned interface and subnet belong to the old tag.
    return res.status(400).json({ error: 'Unsync this VLAN from firewalls before changing its tag' });
  }

  const nextSubnetCidr = nextMode === 'tagged_only'
    ? String(subnetCidr ?? existing.subnet_cidr ?? '').trim()
    : '';
  if (nextMode === 'tagged_only' && !nextSubnetCidr) {
    return res.status(400).json({ error: 'Subnet CIDR is required for tagged-only VLANs' });
  }
  if (nextMode === 'tagged_only' && !isValidCidr(nextSubnetCidr)) {
    return res.status(400).json({ error: 'Invalid subnet CIDR' });
  }

  try {
    await db.update(vlans).set({
      name, tag: requestedTag, mode: nextMode, subnet_cidr: nextSubnetCidr, description: description || '',
    }).where(eq(vlans.id, Number(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VLAN tag already exists' });
    }
    throw err;
  }
});


router.delete('/vlans/:id', pVlans, async (req, res) => {
  const [vlan] = await db.select().from(vlans).where(eq(vlans.id, Number(req.params.id))).limit(1);
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });
  if (!req.session.isAdmin && !await userOwnsVlan(req.session.userId, vlan.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const syncs = await db.select({
    // firewall_vlan_sync columns (was fvs.*)
    id: firewallVlanSync.id, firewall_id: firewallVlanSync.firewall_id, vlan_id: firewallVlanSync.vlan_id,
    interface_name: firewallVlanSync.interface_name, policy_ids: firewallVlanSync.policy_ids,
    dhcp_server_id: firewallVlanSync.dhcp_server_id, synced_at: firewallVlanSync.synced_at,
    artifacts: firewallVlanSync.artifacts, workflow_run_id: firewallVlanSync.workflow_run_id,
    // firewall fields the FortiGate client needs
    fw_id: firewalls.id, fw_name: firewalls.name, host: firewalls.host, port: firewalls.port,
    api_key: firewalls.api_key, vdom: firewalls.vdom, verify_tls: firewalls.verify_tls,
    root_vdom: firewalls.root_vdom, root_wan_zone: firewalls.root_wan_zone, root_vdom_link: firewalls.root_vdom_link,
    trunk_switch_serial: firewalls.trunk_switch_serial, trunk_switch_port: firewalls.trunk_switch_port,
  }).from(firewallVlanSync)
    .innerJoin(firewalls, eq(firewalls.id, firewallVlanSync.firewall_id))
    .where(eq(firewallVlanSync.vlan_id, Number(req.params.id)));

  const fwResults = [];

  // 1. Clean up port forwards that target this VLAN's interface
  const portForwardErrors = new Map();
  for (const sync of syncs) {
    portForwardErrors.set(sync.id, await cleanupVlanPortForwards(sync.fw_id, sync, sync.interface_name));
  }

  // 2. Deprovision VLAN from each synced firewall (interface, address obj, DHCP, routes, policies, switch)
  for (const sync of syncs) {
    const pfErrors = portForwardErrors.get(sync.id);
    if (pfErrors.length > 0) {
      // Keep the VLAN on this firewall while a port forward into it is still live.
      fwResults.push({ firewall: sync.fw_name, status: 'partial', errors: pfErrors });
      continue;
    }
    console.log(`[delete-vlan] Deprovisioning VLAN ${vlan.tag} (${sync.interface_name}) from ${sync.fw_name}`);
    try {
      const client = createClient(sync);
      let errors;
      if (sync.artifacts) {
        // Artifact-based teardown of exactly what the sync run created.
        // artifacts is a jsonb column — already an object.
        ({ errors } = await teardownArtifacts(client, sync.artifacts));
      } else {
        // Legacy row — original live-query deprovision path.
        // policy_ids is a jsonb column — already an array.
        const policyIds = sync.policy_ids || [];
        ({ errors } = await client.deprovisionVlan(sync.interface_name, policyIds, sync.dhcp_server_id, {
          rootVdom: sync.root_vdom || 'root',
          trunkSwitchSerial: sync.trunk_switch_serial || '',
          trunkSwitchPort:   sync.trunk_switch_port   || '',
        }));
      }
      if (errors.length > 0) {
        console.warn(`[delete-vlan] Partial cleanup on ${sync.fw_name}:`, errors);
        fwResults.push({ firewall: sync.fw_name, status: 'partial', errors });
      } else {
        console.log(`[delete-vlan] Successfully removed from ${sync.fw_name}`);
        if (await deleteSyncUnlessForwarded(sync.firewall_id, vlan.id, sync.interface_name)) {
          fwResults.push({ firewall: sync.fw_name, status: 'ok' });
        } else {
          fwResults.push({ firewall: sync.fw_name, status: 'partial', errors: ['A port forward into this VLAN was created during the delete; retry'] });
        }
      }
    } catch (err) {
      console.error(`[delete-vlan] Failed to deprovision from ${sync.fw_name}:`, err.message);
      fwResults.push({ firewall: sync.fw_name, status: 'error', error: err.message });
    }
  }

  const failedCleanup = fwResults.filter(result => result.status !== 'ok');
  if (failedCleanup.length > 0) {
    await logAudit(
      req,
      'admin_delete_vlan_blocked',
      `VLAN ${vlan.tag}`,
      `Firewall cleanup incomplete: ${failedCleanup.map(r => `${r.firewall}=${r.status}`).join(', ')}`
    );
    return res.status(409).json({
      error: 'VLAN cleanup did not complete on all synced firewalls. The VLAN was kept in the portal so you can retry safely.',
      firewallCleanup: fwResults,
    });
  }

  const legacyForwards = (await Promise.all(syncs.map(sync => legacyForwardsNeedingReview(sync.fw_id, vlan.tag)))).flat();

  // 3. Delete the VLAN from DB (CASCADE removes user_vlans and firewall_vlan_sync).
  // Lock the VLAN row (sync creators take it FOR SHARE before inserting their
  // tracking row) and refuse if a sync was committed since `syncs` was read.
  const deleted = await db.transaction(async (tx) => {
    await tx.select({ id: vlans.id }).from(vlans).where(eq(vlans.id, vlan.id)).for('update');
    const [lateSync] = await tx.select({ id: firewallVlanSync.id }).from(firewallVlanSync)
      .where(eq(firewallVlanSync.vlan_id, vlan.id)).limit(1);
    if (lateSync) return false;
    await tx.delete(vlans).where(eq(vlans.id, vlan.id));
    return true;
  });
  if (!deleted) {
    return res.status(409).json({ error: 'The VLAN was synced to a firewall during the delete; retry to remove it there too' });
  }
  await logAudit(req, 'admin_delete_vlan', `VLAN ${vlan.tag}`,
    (fwResults.length ? `FW cleanup: ${fwResults.map(r => `${r.firewall}=${r.status}`).join(', ')}` : '') + legacyReviewNote(legacyForwards));
  res.json({ ok: true, firewallCleanup: fwResults, ...await legacyReviewPayload(req, legacyForwards) });
});

// ─── User VLAN assignments ────────────────────────────────────────────────────

router.get('/users/:id/vlans', pAssignments, async (req, res) => {
  const rows = await db.select({
    id: vlans.id, name: vlans.name, tag: vlans.tag, mode: vlans.mode,
    subnet_cidr: vlans.subnet_cidr, description: vlans.description, created_at: vlans.created_at,
  }).from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, Number(req.params.id)))
    .orderBy(vlans.tag);
  res.json(rows);
});

router.post('/users/:id/vlans', pAssignments, async (req, res) => {
  const { vlanId } = req.body;
  if (!vlanId) return res.status(400).json({ error: 'vlanId required' });
  try {
    await db.insert(userVlans).values({ user_id: Number(req.params.id), vlan_id: vlanId });
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VLAN already assigned to this user' });
    }
    throw err;
  }
});

router.delete('/users/:id/vlans/:vlanId', pAssignments, async (req, res) => {
  await db.delete(userVlans).where(and(eq(userVlans.user_id, Number(req.params.id)), eq(userVlans.vlan_id, Number(req.params.vlanId))));
  res.json({ ok: true });
});

// ─── User VM assignments ──────────────────────────────────────────────────────

router.get('/users/:id/vms', pAssignments, async (req, res) => {
  const rows = await db.select().from(vmAssignments).where(eq(vmAssignments.user_id, Number(req.params.id))).orderBy(vmAssignments.vmid);
  res.json(rows.map(row => ({ ...row, ...serializeNodeIdentity(row.node) })));
});

export default router;
