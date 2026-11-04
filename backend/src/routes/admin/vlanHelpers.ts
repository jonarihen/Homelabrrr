import { and, eq, or, isNull } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { firewalls, firewallVlanSync, managedVips } from '../../db/schema/index.ts';
import { isForeignKeyViolation } from '../../db/errors.ts';
import { createClient, vlanTagToSubnet } from '../../fortigate.ts';
import { ipv4InCidr } from '../../utils/ipPolicy.ts';
import { buildManagedVipAddressName } from '../../utils/vipName.ts';
import { getWorkflowBundle, workflowSettings } from '../../workflows/store.ts';
import { previewBundle, buildFirewallContext, teardownArtifacts, teardownForGoneTarget } from '../../workflows/runner.ts';
import { isArtifactGone } from '../../workflows/engine.ts';
import { deriveSubnet, interfaceCidr, syncedSubnet } from '../../workflows/subnet.ts';
import { canManageAllPortForwards } from './shared.ts';

// Template context for a firewall's vlan_provision workflow (real sync and preview).
export function vlanProvisionContext(vlan, fw, subnet, { allowInternet = true, enableDhcp = true } = {}) {
  return {
    tag: vlan.tag,
    name: vlan.name,
    subnet,
    allowInternet: allowInternet !== false,
    enableDhcp: enableDhcp !== false,
    trunkConfigured: !!(fw.trunk_switch_serial && fw.trunk_switch_port),
    firewall: buildFirewallContext(fw),
  };
}

// What a sync of `tag` to `fw` would record: the /24 that its vlan_provision
// workflow renders for this VLAN's own interface step (a customised step may
// differ from subnet.firstOctet). No such step → nothing recorded → default.
export async function previewSyncSubnet(fw, tag) {
  const bundle = await getWorkflowBundle(fw.id, 'vlan_provision');
  const subnet = bundle && deriveSubnet(tag, workflowSettings(bundle.workflow));
  if (!subnet) return null;
  const preview = previewBundle({ bundle, context: vlanProvisionContext({ tag, name: '' }, fw, subnet), client: { vdom: fw.vdom || 'root' } });
  // Same pick as the sync: the first executed interface step for this tag.
  const iface = preview.find((i) => i.action === 'create_vlan_interface' && !i.skipped && !i.error && Number(i.params?.vlanId) === Number(tag));
  const cidr = interfaceCidr(iface?.params, tag);
  return { ...syncedSubnet(tag, cidr, iface?.params?.ip), recorded: !!cidr };
}

// Insert the tracking row for objects a workflow just created. If its firewall
// or VLAN was deleted meanwhile the FK insert fails: remove those objects
// instead of leaving them live with no record.
export async function trackProvisioned(client, artifacts, insert) {
  try { await insert(); }
  catch (err) {
    if (isForeignKeyViolation(err) || err instanceof TrackingTargetGoneError) throw await teardownForGoneTarget(client, artifacts);
    throw err;
  }
}

export class TrackingTargetGoneError extends Error {}

// Lock the firewall row for the tracking-row insert so DELETE /firewalls/:id
// (which takes it FOR UPDATE, checks dependents, then deletes) cannot slip in.
export async function lockFirewallForTracking(tx, firewallId) {
  const [live] = await tx.select({ id: firewalls.id }).from(firewalls).where(eq(firewalls.id, firewallId)).for('share');
  if (!live) throw new TrackingTargetGoneError('Firewall was deleted during provisioning');
}

// Port-forward creation and VLAN unsync race on the sync row: the creator
// inserts its managed_vips row while holding the sync row FOR SHARE (and
// fails if it is gone); unsync deletes the sync row (waiting on that lock)
// and then re-checks for forwards created meanwhile. Locks are only held for
// these DB statements, never across FortiGate calls.
export async function insertForwardIfVlanSynced(firewallId, vlanInterface, row) {
  await db.transaction(async (tx) => {
    await lockFirewallForTracking(tx, firewallId);
    if (vlanInterface) {
      const [live] = await tx.select({ id: firewallVlanSync.id }).from(firewallVlanSync)
        .where(and(eq(firewallVlanSync.firewall_id, firewallId), eq(firewallVlanSync.interface_name, vlanInterface)))
        .for('share');
      if (!live) throw new TrackingTargetGoneError('VLAN was unsynced during provisioning');
    }
    await tx.insert(managedVips).values(row);
  });
}

// Returns false (and keeps the sync row) when a forward into the VLAN appeared.
export async function deleteSyncUnlessForwarded(firewallId, vlanId, vlanInterface) {
  try {
    await db.transaction(async (tx) => {
      await tx.delete(firewallVlanSync).where(and(eq(firewallVlanSync.firewall_id, firewallId), eq(firewallVlanSync.vlan_id, vlanId)));
      const [pf] = await tx.select({ id: managedVips.id }).from(managedVips)
        .where(and(eq(managedVips.firewall_id, firewallId), eq(managedVips.vlan_interface, vlanInterface))).limit(1);
      if (pf) throw new TrackingTargetGoneError('port forward created during unsync');
    });
    return true;
  } catch (err) {
    if (err instanceof TrackingTargetGoneError) return false;
    throw err;
  }
}

// Every FortiGate object a legacy managed VIP (no recorded artifacts) owns, in
// teardown order. Each step is independent: a failure must not stop the rest
// of the cleanup, and an object already gone upstream is not an error.
export function managedVipCleanupSteps(pf, sync, rootVdom) {
  const labVdom = sync.vdom || 'lab';
  const steps = [];
  if (pf.policy_id) {
    steps.push({ label: `Root policy ${pf.policy_id}`, run: (c) => c.deletePolicy(pf.policy_id, rootVdom) });
  }
  if (pf.lab_policy_id) {
    steps.push({ label: `Lab policy ${pf.lab_policy_id}`, run: (c) => c.deletePolicy(pf.lab_policy_id, labVdom) });
  }
  steps.push({ label: `VIP ${pf.vip_name}`, run: (c) => c.deleteVip(pf.vip_name, rootVdom) });
  if (pf.service_name) {
    steps.push({ label: `Service ${pf.service_name}`, run: (c) => c.deleteServiceObject(pf.service_name, rootVdom) });
    steps.push({ label: `Lab service ${pf.service_name}`, run: (c) => c.deleteServiceObject(pf.service_name, labVdom) });
  }
  if (pf.vlan_interface) {
    const labAddressName = buildManagedVipAddressName(pf.vip_name, pf.mapped_ip);
    steps.push({ label: `Lab address ${labAddressName}`, run: (c) => c.deleteAddressObject(labAddressName, labVdom) });
  }
  return steps;
}

// Remove every managed port forward that targets a VLAN interface on one
// firewall. Rows with recorded artifacts are torn down from them; legacy rows
// use the fixed cleanup sequence. A row is only deleted once its FortiGate
// cleanup succeeded, so a failed attempt keeps the record for a retry.
// Returns the cleanup errors. `fw` carries the connection fields createClient
// needs plus vdom/root_vdom.
export async function cleanupVlanPortForwards(firewallId, fw, vlanIfaceName) {
  // Only forwards explicitly linked to this VLAN; see legacyForwardsNeedingReview.
  const portForwards = await db.select().from(managedVips)
    .where(and(eq(managedVips.firewall_id, firewallId), eq(managedVips.vlan_interface, vlanIfaceName)));
  const allErrors = [];
  if (portForwards.length === 0) return allErrors;

  console.log(`[delete-vlan] Cleaning up ${portForwards.length} port forward(s) on firewall ${firewallId} for ${vlanIfaceName}`);
  const client = createClient(fw);
  const rootVdom = fw.root_vdom || 'root';

  for (const pf of portForwards) {
    let errors = [];
    if (pf.artifacts) {
      ({ errors } = await teardownArtifacts(client, pf.artifacts));
    } else {
      for (const step of managedVipCleanupSteps(pf, fw, rootVdom)) {
        try { await step.run(client); }
        catch (e) { if (!isArtifactGone(e)) errors.push(`${step.label}: ${e.message}`); }
      }
    }
    if (errors.length > 0) {
      console.warn(`[delete-vlan] Failed to fully clean port forward "${pf.vip_name}":`, errors);
      allErrors.push(...errors.map(e => `port forward ${pf.vip_name}: ${e}`));
      continue;
    }
    await db.delete(managedVips).where(eq(managedVips.id, pf.id));
    console.log(`[delete-vlan] Cleaned up port forward "${pf.vip_name}"`);
  }
  return allErrors;
}

// Pre-dual-VDOM forwards (no vlan_interface, artifacts or run) whose mapped IP
// lies in the VLAN's legacy 10.x subnet. An IP overlap does not prove they
// belong to the VLAN, so they are never removed here — only reported, for an
// admin to review and delete through the VIP endpoint.
export async function legacyForwardsNeedingReview(firewallId, vlanTag) {
  const legacySubnet = vlanTagToSubnet(vlanTag);
  if (!legacySubnet) return [];
  const rows = await db.select({ vip_name: managedVips.vip_name, mapped_ip: managedVips.mapped_ip }).from(managedVips)
    .where(and(eq(managedVips.firewall_id, firewallId),
      or(eq(managedVips.vlan_interface, ''), isNull(managedVips.vlan_interface)),
      isNull(managedVips.artifacts), isNull(managedVips.workflow_run_id)));
  return rows.filter(r => ipv4InCidr(r.mapped_ip, legacySubnet.network))
    .map(r => ({ firewallId, name: r.vip_name, mapped_ip: r.mapped_ip }));
}

// Names and IPs only for those who may see every port forward; others get a count.
export async function legacyReviewPayload(req, rows) {
  return {
    legacyForwardsNeedingReviewCount: rows.length,
    ...(await canManageAllPortForwards(req) ? { legacyForwardsNeedingReview: rows } : {}),
  };
}

export function legacyReviewNote(rows) {
  return rows.length
    ? `; WARNING legacy port forwards in this VLAN's subnet were not removed, review them: ${rows.map(r => `${r.name} (${r.mapped_ip})`).join(', ')}`
    : '';
}
