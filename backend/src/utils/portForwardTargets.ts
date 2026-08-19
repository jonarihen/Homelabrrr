// Port-forward target eligibility.
//
// A VM can only be published through a firewall when four independent things
// line up: Homelabrrr knows its IP, its NIC carries a VLAN tag, that VLAN has
// been synced to the firewall, and (for non-privileged users) the VLAN is
// assigned to them. Historically each of those was a silent `.filter()` — the
// VM just vanished from the "Target VM" dropdown with no explanation, which is
// the single most-reported "why can't I set this up" case.
//
// This module keeps every accessible VM in the list and annotates it with
// `eligible` plus a structured `blocked` reason instead. It is deliberately
// pure — plain rows in, plain rows out, no db handle and no network — so the
// classification can be unit-tested standalone and so the API route and the
// create path share exactly one definition of "blocked".

/** Reason codes, listed in the precedence order they are reported in. */
export const BLOCKED_CODES = ['no_ip', 'untagged', 'vlan_not_synced', 'vlan_not_assigned'];

const VM_TYPES = new Set(['qemu', 'lxc']);

function vmKey(vm) {
  return `${vm.nodeRef || vm.node}/${vm.vmid}`;
}

function vmHref(vm) {
  return `/vm/${vm.nodeRef || vm.node}/${vm.vmid}`;
}

/**
 * Human label for a VLAN tag: "office (tag 1001)" when the VLAN is registered
 * in Homelabrrr, "tag 1001" when the NIC carries a tag we know nothing about.
 */
export function vlanLabel(tag, name) {
  const trimmed = String(name || '').trim();
  return trimmed ? `${trimmed} (tag ${tag})` : `tag ${tag}`;
}

/**
 * Resolve a VM's `vm_ssh_configs` row.
 *
 * Rows are keyed by the node value that was current when they were saved, so
 * legacy rows hold a bare Proxmox node name while new ones hold the
 * `<hostId>~<node>` ref. Falling back to the bare key is only safe when that
 * bare `node/vmid` pair is unambiguous across every registered cluster, hence
 * the count over the *full* VM list.
 */
function makeSshLookup(allVms, sshConfigs) {
  const sshMap = new Map(sshConfigs.map((c) => [`${c.node}/${c.vmid}`, c]));
  const rawCounts = new Map();
  for (const vm of allVms) {
    const raw = `${vm.node}/${vm.vmid}`;
    rawCounts.set(raw, (rawCounts.get(raw) || 0) + 1);
  }
  return (vm) => {
    const raw = `${vm.node}/${vm.vmid}`;
    return sshMap.get(vmKey(vm))
      || (rawCounts.get(raw) === 1 ? sshMap.get(raw) : null)
      || null;
  };
}

// Accepts a Map, an array of [key, tag] pairs, an array of { key, vlanTag }
// records, or a plain object — whichever is cheapest for the caller to build.
function toTagMap(value) {
  if (!value) return new Map();
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    return new Map(value.map((entry) => (
      Array.isArray(entry) ? entry : [entry.key, entry.vlanTag]
    )));
  }
  return new Map(Object.entries(value));
}

function intOrNull(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

function blockedNoIp(vm) {
  return {
    code: 'no_ip',
    short: 'no IP recorded',
    message: "Homelabrrr doesn't know this VM's IP address yet.",
    action: 'Set the SSH Host/IP on the VM page.',
    href: vmHref(vm),
  };
}

function blockedUntagged(vm) {
  return {
    code: 'untagged',
    short: 'no VLAN tag',
    message: "This VM's network interface has no VLAN tag, so there's no firewall interface to publish through.",
    action: "Set a VLAN on the VM's network interface.",
    href: vmHref(vm),
  };
}

function blockedVlanNotSynced(label, firewallName, canManageVlans) {
  const fw = String(firewallName || '').trim();
  return {
    code: 'vlan_not_synced',
    short: 'VLAN not synced to this firewall',
    message: `VLAN ${label} hasn't been synced to firewall ${fw || 'this firewall'} yet.`,
    action: canManageVlans
      ? 'Sync it under Networking → VLANs.'
      : 'An admin needs to sync it under Networking → VLANs.',
    href: canManageVlans ? '/admin/vlans' : null,
  };
}

function blockedVlanNotAssigned(label) {
  return {
    code: 'vlan_not_assigned',
    short: 'VLAN not assigned to you',
    message: `VLAN ${label} isn't assigned to you.`,
    action: 'Ask an admin for access to this VLAN.',
    href: null,
  };
}

/**
 * Annotate every VM the caller decided the user may see with its port-forward
 * eligibility.
 *
 * Precedence when several prerequisites are missing at once follows the order
 * in `BLOCKED_CODES`: the fact closest to the VM is reported first, so fixing
 * one reason reveals the next. Only one reason is surfaced at a time — a wall
 * of four simultaneous complaints is worse than a single next step.
 *
 * @param {object[]} opts.vms            every VM row from Proxmox (used for the
 *                                       bare-node disambiguation count)
 * @param {string[]|null} opts.accessibleKeys `"<nodeRef>/<vmid>"` keys the user
 *                                       may see; null means "all of them"
 * @param {object[]} opts.sshConfigs     `vm_ssh_configs` rows ({ node, vmid, host, port })
 * @param {Map|Array|object} opts.vlanTags  `"<nodeRef>/<vmid>"` → VLAN tag from net0
 * @param {object[]} opts.vlans          `vlans` rows ({ id, name, tag })
 * @param {object[]} opts.vlanSyncs      `firewall_vlan_sync` rows for THIS firewall,
 *                                       unscoped by user ({ vlan_tag, interface_name })
 * @param {number[]} opts.userVlanTags   VLAN tags assigned to the user
 * @param {boolean} opts.unrestricted    user may manage port forwards firewall-wide
 * @param {boolean} opts.canManageVlans  user may sync VLANs (controls the fix link)
 * @param {string} opts.rootDstInterface root-VDOM link interface for the firewall
 * @param {string} opts.firewallName     used in the vlan_not_synced message
 */
export function buildPortForwardTargets({
  vms = [],
  accessibleKeys = null,
  sshConfigs = [],
  vlanTags = null,
  vlans = [],
  vlanSyncs = [],
  userVlanTags = [],
  unrestricted = false,
  canManageVlans = false,
  rootDstInterface = '',
  firewallName = '',
} = {}) {
  const accessible = accessibleKeys ? new Set(accessibleKeys) : null;
  const findSsh = makeSshLookup(vms, sshConfigs);
  const tagMap = toTagMap(vlanTags);

  const vlanNameByTag = new Map();
  for (const v of vlans) {
    const tag = intOrNull(v?.tag);
    if (tag !== null) vlanNameByTag.set(tag, v.name || '');
  }

  const interfaceByTag = new Map();
  for (const s of vlanSyncs) {
    const tag = intOrNull(s?.vlan_tag ?? s?.tag);
    if (tag !== null && s.interface_name) interfaceByTag.set(tag, s.interface_name);
  }

  const assignedTags = new Set();
  for (const t of userVlanTags) {
    const tag = intOrNull(t);
    if (tag !== null) assignedTags.add(tag);
  }

  const targets = [];
  for (const vm of vms) {
    if (!VM_TYPES.has(vm.type)) continue;
    const key = vmKey(vm);
    if (accessible && !accessible.has(key)) continue;

    const ssh = findSsh(vm);
    const ip = String(ssh?.host || '').trim();
    const vlanTag = intOrNull(tagMap.get(key)) || null;
    const vlanName = vlanTag !== null ? (vlanNameByTag.get(vlanTag) || '') : '';
    const syncedInterface = vlanTag !== null ? (interfaceByTag.get(vlanTag) || '') : '';
    const vlanAssigned = vlanTag !== null && assignedTags.has(vlanTag);

    let blocked = null;
    if (!ip) {
      blocked = blockedNoIp(vm);
    } else if (vlanTag === null) {
      blocked = blockedUntagged(vm);
    } else if (!syncedInterface) {
      blocked = blockedVlanNotSynced(vlanLabel(vlanTag, vlanName), firewallName, canManageVlans);
    } else if (!unrestricted && !vlanAssigned) {
      blocked = blockedVlanNotAssigned(vlanLabel(vlanTag, vlanName));
    }

    // A restricted user must never be handed an interface for a VLAN that is
    // not theirs — the create path re-derives mappedIp/dstInterface from this
    // very row, so leaking it here would be an authorization hole.
    const vlanInterface = (unrestricted || vlanAssigned) ? syncedInterface : '';
    const dstInterface = vlanInterface ? rootDstInterface : '';
    const eligible = !blocked;

    targets.push({
      node: vm.node,
      nodeRef: vm.nodeRef || vm.node,
      vmid: vm.vmid,
      name: vm.name || `VM ${vm.vmid}`,
      status: vm.status,
      type: vm.type,
      ip,
      sshPort: ssh?.port || 22,
      vlanTag,
      vlanName,
      dstInterface,
      vlanInterface,
      eligible,
      // Privileged users can still pick a VLAN-blocked VM and choose the
      // destination interface by hand, which is how it has always worked.
      overridable: !eligible && unrestricted && !!ip,
      blocked,
    });
  }

  return targets.sort((a, b) => {
    const aPick = a.eligible || a.overridable ? 0 : 1;
    const bPick = b.eligible || b.overridable ? 0 : 1;
    if (aPick !== bPick) return aPick - bPick;
    return a.name.localeCompare(b.name);
  });
}

/** Flatten a blocked reason into the single-line `error` string an API returns. */
export function blockedErrorText(blocked) {
  if (!blocked) return '';
  return [blocked.message, blocked.action].filter(Boolean).join(' ');
}

/** HTTP status for a blocked reason: authorization vs. missing configuration. */
export function blockedStatus(blocked) {
  return blocked?.code === 'vlan_not_assigned' ? 403 : 400;
}
