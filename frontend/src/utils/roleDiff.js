// Pure helpers behind the Roles page: permission labels, search filtering, and
// the before/after diff shown in the review step before a role is saved.

export const PERM_GROUPS = [
  {
    label: 'VM Access',
    perms: [
      { key: 'see_all_vms', label: 'View all VMs (read-only)', desc: 'See every VM on Proxmox without individual assignments — status, config, graphs and backup listings only. Grants no power, console or edit rights.' },
      { key: 'can_operate_all_vms', label: 'Operate all VMs', desc: 'Full operator control of every VM: VNC console, SSH and SFTP shell, power on/off/reboot, snapshots, backups, VLAN and hardware changes. Console + SSH on the whole fleet is effectively root on the fleet.', danger: true },
      { key: 'can_provision', label: 'Provision VMs', desc: 'Create VMs from templates and cloud images' },
      { key: 'can_create_vms', label: 'Create VMs', desc: 'Build VMs from scratch / from an available ISO' },
      { key: 'can_edit_vm_hardware', label: 'Edit VM Hardware', desc: 'Change CPU, memory, and disk size on assigned VMs' },
    ],
  },
  {
    label: 'Admin Features',
    perms: [
      { key: 'can_manage_hosts', label: 'Manage PVE Hosts', desc: 'Add, edit, and remove Proxmox hypervisor connections' },
      { key: 'can_manage_firewalls', label: 'Manage Firewalls', desc: 'Configure FortiGate firewalls and switch discovery' },
      { key: 'can_manage_port_forwards', label: 'Manage Port Forwards', desc: 'Create and remove scoped WAN port forwards' },
      { key: 'can_manage_vlans', label: 'Manage VLANs', desc: 'Create, edit, delete VLANs and sync to firewalls' },
      { key: 'can_manage_policies', label: 'Manage Policies', desc: 'Create and remove firewall policies between VLANs' },
      { key: 'can_manage_templates', label: 'Manage Templates', desc: 'Register and configure VM provisioning templates' },
      { key: 'can_manage_users', label: 'Manage Users', desc: 'Create, edit, delete user accounts and permissions' },
      { key: 'can_manage_assignments', label: 'Manage Assignments', desc: 'Assign VMs and VLANs to users' },
      { key: 'can_view_audit_log', label: 'View Audit Log', desc: 'Read the system audit log' },
      { key: 'can_manage_websites', label: 'Manage Websites', desc: 'Register the Caddy reverse proxy, see all published sites, and assign site ownership' },
      { key: 'can_manage_public_ips', label: 'Manage Public IPs', desc: 'Register public IP pools, reserve addresses, and assign dedicated public IPs to users' },
    ],
  },
];

const PERM_INDEX = new Map(PERM_GROUPS.flatMap((g) => g.perms.map((p) => [p.key, p])));

export function permLabel(key) {
  return PERM_INDEX.get(key)?.label || key;
}

export function isDangerPerm(key) {
  return !!PERM_INDEX.get(key)?.danger;
}

// Case-insensitive match on the role name, description, or any granted
// permission's key/label.
export function roleMatchesQuery(role, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    role.name, role.description,
    ...(role.permissions || []).flatMap((k) => [k, permLabel(k)]),
  ].filter(Boolean).join('\n').toLowerCase();
  return hay.includes(q);
}

const QUOTA_FIELDS = [
  { key: 'maxCores', column: 'max_cores', label: 'Max CPU cores', unit: '' },
  { key: 'maxMemoryGb', column: 'max_memory_gb', label: 'Max memory', unit: ' GB' },
  { key: 'maxStorageGb', column: 'max_storage_gb', label: 'Max storage', unit: ' GB' },
];

function normQuota(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function fmtQuota(v, unit) {
  return v === null ? 'unlimited' : `${v}${unit}`;
}

// Draft = { name, description, permissions: string[]|Set, maxCores, maxMemoryGb, maxStorageGb }
// Original = a serialized role from GET /admin/roles (or null when creating).
// Returns a flat list of { kind, label, from?, to?, danger? } entries.
export function diffRole(original, draft) {
  const changes = [];
  const before = original || { name: '', description: '', permissions: [] };
  if ((draft.name || '').trim() !== (before.name || '')) {
    changes.push({ kind: 'field', label: 'Name', from: before.name || '—', to: (draft.name || '').trim() });
  }
  if ((draft.description || '') !== (before.description || '')) {
    changes.push({ kind: 'field', label: 'Description', from: before.description || '—', to: draft.description || '—' });
  }
  const oldPerms = new Set(before.permissions || []);
  const newPerms = new Set(draft.permissions || []);
  for (const key of [...newPerms].filter((k) => !oldPerms.has(k)).sort()) {
    changes.push({ kind: 'grant', label: permLabel(key), key, danger: isDangerPerm(key) });
  }
  for (const key of [...oldPerms].filter((k) => !newPerms.has(k)).sort()) {
    changes.push({ kind: 'revoke', label: permLabel(key), key });
  }
  for (const q of QUOTA_FIELDS) {
    const from = normQuota(before[q.column]);
    const to = normQuota(draft[q.key]);
    if (from !== to) changes.push({ kind: 'field', label: q.label, from: fmtQuota(from, q.unit), to: fmtQuota(to, q.unit) });
  }
  return changes;
}
