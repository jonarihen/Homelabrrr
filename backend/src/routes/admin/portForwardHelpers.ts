import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users, vmAssignments, vmSshConfigs, vlans, userVlans, firewallVlanSync } from '../../db/schema/index.ts';
import { getAllVMs, getVMConfig } from '../../proxmox.ts';
import { createClient } from '../../fortigate.ts';
import { userCanAccessVm } from '../../utils/vmAccess.ts';
import { userHasPermission } from '../../utils/permissions.ts';
import { buildPortForwardTargets } from '../../utils/portForwardTargets.ts';
import { canManageAllPortForwards } from './shared.ts';

export async function getScopedFirewallSyncs(userId, firewallId, unrestricted = false) {
  const cols = {
    interface_name: firewallVlanSync.interface_name,
    vlan_id: vlans.id,
    vlan_name: vlans.name,
    vlan_tag: vlans.tag,
  };
  if (unrestricted) {
    return db.select(cols).from(firewallVlanSync)
      .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
      .where(eq(firewallVlanSync.firewall_id, firewallId));
  }

  return db.select(cols).from(firewallVlanSync)
    .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
    .innerJoin(userVlans, and(eq(userVlans.vlan_id, vlans.id), eq(userVlans.user_id, userId)))
    .where(eq(firewallVlanSync.firewall_id, firewallId));
}

// Every VM the user can see, annotated with whether it can be published through
// `fw` and — when it cannot — a structured reason. Nothing is filtered out:
// silently dropping VMs is exactly what made this screen impossible to debug.
// The classification itself lives in utils/portForwardTargets.js so it is pure
// and unit-testable; this function only gathers the rows it needs.
export async function getScopedPortForwardTargets(req, fw) {
  const unrestricted = await canManageAllPortForwards(req);
  const canManageVlans = req.session.isAdmin || await userHasPermission(req.session.userId, 'can_manage_vlans');

  const vms = await getAllVMs();
  const sshConfigs = await db.select({
    node: vmSshConfigs.node, vmid: vmSshConfigs.vmid, host: vmSshConfigs.host, port: vmSshConfigs.port,
  }).from(vmSshConfigs);
  const vlanRows = await db.select({ id: vlans.id, name: vlans.name, tag: vlans.tag }).from(vlans);
  const vlanSyncs = await db.select({
    interface_name: firewallVlanSync.interface_name, vlan_tag: vlans.tag,
  }).from(firewallVlanSync)
    .innerJoin(vlans, eq(vlans.id, firewallVlanSync.vlan_id))
    .where(eq(firewallVlanSync.firewall_id, fw.id));
  const userVlanTags = (await db.select({ tag: vlans.tag }).from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, req.session.userId))).map(r => r.tag);

  const accessChecks = await Promise.all(vms.map(async (vm) => {
    if (vm.type !== 'qemu' && vm.type !== 'lxc') return false;
    if (unrestricted) return true;
    return userCanAccessVm(req.session.userId, vm.nodeRef || vm.node, vm.vmid, req.session.isAdmin);
  }));
  const accessibleVms = vms.filter((_vm, i) => accessChecks[i]);
  const accessibleKeys = accessibleVms.map(vm => `${vm.nodeRef || vm.node}/${vm.vmid}`);

  // Only VMs that already have an IP need a config fetch: a VM without one is
  // blocked by `no_ip` regardless of its VLAN tag, and that reason outranks the
  // VLAN ones. Keeps the Proxmox call count identical to before this change.
  const sshKeys = new Set(sshConfigs.filter(c => c.host).map(c => `${c.node}/${c.vmid}`));
  const rawVmCounts = new Map();
  for (const vm of vms) {
    const raw = `${vm.node}/${vm.vmid}`;
    rawVmCounts.set(raw, (rawVmCounts.get(raw) || 0) + 1);
  }
  const configTargets = accessibleVms.filter(vm => {
    const raw = `${vm.node}/${vm.vmid}`;
    return sshKeys.has(`${vm.nodeRef || vm.node}/${vm.vmid}`)
      || (rawVmCounts.get(raw) === 1 && sshKeys.has(raw));
  });

  const configResults = await Promise.allSettled(
    configTargets.map(async vm => {
      const routeNode = vm.nodeRef || vm.node;
      try {
        const cfg = await getVMConfig(routeNode, vm.vmid);
        const net0 = cfg.net0 || '';
        const tagMatch = net0.match(/tag=(\d+)/);
        return { key: `${routeNode}/${vm.vmid}`, vlanTag: tagMatch ? parseInt(tagMatch[1], 10) : null };
      } catch {
        return { key: `${routeNode}/${vm.vmid}`, vlanTag: null };
      }
    })
  );

  const vlanTagMap = new Map();
  for (const result of configResults) {
    if (result.status === 'fulfilled') vlanTagMap.set(result.value.key, result.value.vlanTag);
  }

  return buildPortForwardTargets({
    vms,
    accessibleKeys,
    sshConfigs,
    vlanTags: vlanTagMap,
    vlans: vlanRows,
    vlanSyncs,
    userVlanTags,
    unrestricted,
    canManageVlans,
    rootDstInterface: fw.root_vdom_link || 'lab-root1',
    firewallName: fw.name || '',
  });
}


// ─── Port Forwarding (VIPs in root VDOM) ─────────────────────────────────

// Quick helper to get firewall + client for root VDOM ops
export function getRootClient(fw) {
  const client = createClient(fw);
  return { client, rootVdom: fw.root_vdom || 'root' };
}

export function managedVipServiceMatches(service, protocol, portNumber) {
  const port = String(portNumber);
  const tcpRange = String(service?.['tcp-portrange'] || '').trim();
  const udpRange = String(service?.['udp-portrange'] || '').trim();

  if (protocol === 'udp') {
    return udpRange === port && !tcpRange;
  }
  return tcpRange === port && !udpRange;
}

export function managedVipAddressMatches(address, mappedIp) {
  const subnet = String(address?.subnet || '').trim();
  return String(address?.type || 'ipmask') === 'ipmask' && subnet === `${mappedIp} 255.255.255.255`;
}

// Sequence-group label for a port forward's root-VDOM policy: one group per
// owning user, so it's obvious who has what open. FortiGate's GUI shows one
// group only when same-label policies are also adjacent — creation and the
// regroup endpoint both keep them contiguous.
export async function portForwardOwnerUsername(vmid, mappedIp) {
  if (vmid) {
    const [byVmid] = await db.select({ username: users.username }).from(vmAssignments)
      .innerJoin(users, eq(users.id, vmAssignments.user_id))
      .where(eq(vmAssignments.vmid, parseInt(vmid, 10))).limit(1);
    if (byVmid) return byVmid.username;
  }
  if (mappedIp) {
    const [byIp] = await db.select({ username: users.username }).from(vmSshConfigs)
      .innerJoin(vmAssignments, eq(vmAssignments.vmid, vmSshConfigs.vmid))
      .innerJoin(users, eq(users.id, vmAssignments.user_id))
      .where(eq(vmSshConfigs.host, mappedIp)).limit(1);
    if (byIp) return byIp.username;
  }
  return '';
}

export async function portForwardGroupLabel(vmid, mappedIp) {
  const username = await portForwardOwnerUsername(vmid, mappedIp);
  return username ? `Port Forwarding - ${username}` : 'Port Forwarding (VM Manager)';
}

// FortiGate's GUI derives sequence sections from global-label markers: a
// non-empty label STARTS a new section, which then runs until the next
// labeled policy. Only the group's first policy (the anchor) may carry the
// label — stamping it on every member renders each one as its own "(#N)"
// section. Park `policyId` at the end of the `label` section, or make it the
// anchor if the section doesn't exist yet. Best effort: grouping is cosmetic
// and must never fail the operation that created the policy.
export async function joinSequenceGroup(client, policyId, label, vdom = null) {
  if (!policyId || !label) return;
  try {
    const policies = await client.getPolicies(vdom);
    const self = policies.find((p) => String(p.policyid) === String(policyId));
    const anchorIdx = policies.findIndex((p) =>
      (p['global-label'] || '') === label && String(p.policyid) !== String(policyId));
    if (anchorIdx === -1) {
      if ((self?.['global-label'] || '') !== label) {
        await client.updatePolicy(policyId, { 'global-label': label }, vdom);
      }
      return;
    }
    // The section's tail is the last consecutive unlabeled policy after the anchor
    let tailId = policies[anchorIdx].policyid;
    for (let i = anchorIdx + 1; i < policies.length; i++) {
      if (String(policies[i].policyid) === String(policyId)) continue;
      if ((policies[i]['global-label'] || '') !== '') break;
      tailId = policies[i].policyid;
    }
    if ((self?.['global-label'] || '') !== '') {
      await client.updatePolicy(policyId, { 'global-label': '' }, vdom);
    }
    await client.movePolicy(policyId, 'after', tailId, vdom);
  } catch { /* best effort */ }
}

export function normalizePortForwardProtocol(protocol) {
  const normalized = String(protocol || 'tcp').toLowerCase();
  return ['tcp', 'udp'].includes(normalized) ? normalized : null;
}

export function parsePortForwardPort(value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

export function buildPortSpecificCustomVipName(vipName, protocol, port) {
  const trimmedName = String(vipName || '').trim();
  if (!trimmedName) return '';
  if (/\b\d{1,5}\/(?:tcp|udp)$/i.test(trimmedName)) return trimmedName;
  if (/\bcustom$/i.test(trimmedName)) return `${trimmedName} ${port}/${protocol}`;
  return trimmedName;
}

// Walk the policy list top-to-bottom; the first policy of each label is the
// group anchor and keeps its position. Every later policy with the same label
// is moved directly after the group's current tail, so each label ends up as
// one contiguous block. Labels follow FortiGate's section semantics (see
// joinSequenceGroup): the anchor carries the group's global-label, every
// other member gets it CLEARED — a non-empty label starts a new "(#N)"
// section in the GUI. Policies without a portal label are never touched.
export async function regroupAdjacent(client, vdom, labelFor, warnings) {
  let moved = 0;
  let relabeled = 0;
  const policies = await client.getPolicies(vdom);
  const tails = new Map(); // label → policyid of the group's current bottom
  for (const p of policies) {
    const label = labelFor(p);
    if (!label) continue;
    const tail = tails.get(label);
    const wantLabel = tail === undefined ? label : '';
    if ((p['global-label'] || '') !== wantLabel) {
      try {
        await client.updatePolicy(p.policyid, { 'global-label': wantLabel }, vdom);
        relabeled += 1;
      } catch (err) {
        warnings.push(`${vdom} policy ${p.policyid} label: ${err.message}`);
      }
    }
    if (tail !== undefined) {
      try {
        await client.movePolicy(p.policyid, 'after', tail, vdom);
        moved += 1;
      } catch (err) {
        warnings.push(`${vdom} policy ${p.policyid} move: ${err.message}`);
      }
    }
    tails.set(label, p.policyid);
  }
  return { moved, relabeled };
}
