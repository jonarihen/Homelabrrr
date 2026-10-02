// Pure helpers for the staged Manage User modal: build a local draft from the
// server state, diff it for the review step, and turn it into the single
// PATCH /admin/users/:id payload.
import { permLabel, isDangerPerm } from './roleDiff.js';
import { displayNode, routeNode, vmIdentityKey } from './nodeRef.js';

export const QUOTA_KEYS = [
  { key: 'maxCores', column: 'max_cores', label: 'Max CPU cores', unit: '' },
  { key: 'maxMemoryGb', column: 'max_memory_gb', label: 'Max memory', unit: ' GB' },
  { key: 'maxStorageGb', column: 'max_storage_gb', label: 'Max storage', unit: ' GB' },
];

function quotaValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

// Quotas must be empty (unlimited/inherit) or a non-negative whole number —
// the same rule the server enforces — so the reviewed value is the saved one.
export function invalidQuotaKeys(quotas) {
  return QUOTA_KEYS.filter((q) => {
    const v = quotas[q.key];
    if (v === null || v === undefined || v === '') return false;
    return !/^\d{1,10}$/.test(String(v).trim()) || Number(String(v).trim()) > 2147483647;
  }).map((q) => q.key);
}

// Mirrors backend resolveEffectivePermissions: a role, when assigned, fully
// defines the set; without one the per-user flags apply.
export function effectivePermissionSet(roleId, flags, roles) {
  if (roleId !== '' && roleId != null) {
    const role = roles.find((r) => String(r.id) === String(roleId));
    return new Set(role?.permissions || []);
  }
  return new Set(Object.entries(flags).filter(([, on]) => on).map(([k]) => k));
}

export function draftFromState(state) {
  return {
    roleId: state.role_id == null ? '' : String(state.role_id),
    permissions: { ...state.permissions },
    require2fa: !!state.require_2fa,
    quotas: Object.fromEntries(QUOTA_KEYS.map((q) => [q.key, state.quotas[q.column] ?? ''])),
    vmKeys: new Set(state.vms.map(vmIdentityKey)),
    vlanIds: new Set(state.vlan_ids),
  };
}

function vmLabel(vm) {
  return `${vm.name || `VM ${vm.vmid}`} (${displayNode(vm.node || vm.nodeRef)} · ${vm.vmid})`;
}

// Returns the minimal patch — only the sections that differ — or null when the
// draft matches the server state.
export function buildUserPatch(state, draft, { allVMs = [] } = {}) {
  const body = {};
  const baseRole = state.role_id == null ? '' : String(state.role_id);
  if (draft.roleId !== baseRole) {
    body.roleId = draft.roleId === '' ? null : Number(draft.roleId);
    if (body.roleId !== null) {
      const definition = state.roleDefinitions?.find((r) => String(r.id) === draft.roleId);
      body.roleVersion = definition?.version;
    }
  }

  const perms = {};
  for (const [k, v] of Object.entries(draft.permissions)) {
    if (!!state.permissions[k] !== !!v) perms[k] = !!v;
  }
  if (Object.keys(perms).length) body.permissions = perms;

  if (draft.require2fa !== !!state.require_2fa) body.require2fa = draft.require2fa;

  const quotaChanged = QUOTA_KEYS.some((q) => quotaValue(draft.quotas[q.key]) !== quotaValue(state.quotas[q.column]));
  if (quotaChanged) body.quotas = { ...draft.quotas };

  const baseVmKeys = new Set(state.vms.map(vmIdentityKey));
  const add = [...draft.vmKeys].filter((k) => !baseVmKeys.has(k)).map((k) => {
    const vm = allVMs.find((v) => vmIdentityKey(v) === k);
    return vm ? { node: routeNode(vm), vmid: Number(vm.vmid) } : null;
  }).filter(Boolean);
  const remove = state.vms.filter((a) => !draft.vmKeys.has(vmIdentityKey(a))).map((a) => a.id);
  if (add.length || remove.length) body.vms = { add, remove };

  const baseVlans = new Set(state.vlan_ids);
  const vlanAdd = [...draft.vlanIds].filter((id) => !baseVlans.has(id));
  const vlanRemove = state.vlan_ids.filter((id) => !draft.vlanIds.has(id));
  if (vlanAdd.length || vlanRemove.length) body.vlans = { add: vlanAdd, remove: vlanRemove };

  return Object.keys(body).length ? { ...body, version: state.version } : null;
}

// Human-readable change list for the review step. `danger` marks a change that
// needs a deliberate confirmation (typing the username).
export function describeUserChanges(state, draft, { allVMs = [], allVLANs = [], roles = [] } = {}) {
  const changes = [];
  const roleName = (id) => (id === '' || id == null ? 'No role' : roles.find((r) => String(r.id) === String(id))?.name || `#${id}`);
  const baseRole = state.role_id == null ? '' : String(state.role_id);
  // Diff what the user can actually do, not the raw columns: removing a role
  // re-activates dormant per-user flags, and adding one masks them.
  const before = effectivePermissionSet(baseRole, state.permissions, roles);
  const after = effectivePermissionSet(draft.roleId, draft.permissions, roles);
  const granted = [...after].filter((k) => !before.has(k)).sort();
  const revoked = [...before].filter((k) => !after.has(k)).sort();
  if (draft.roleId !== baseRole) {
    changes.push({
      kind: 'field', label: 'Role', from: roleName(baseRole), to: roleName(draft.roleId),
      danger: granted.some(isDangerPerm),
    });
  }
  for (const k of granted) changes.push({ kind: 'grant', label: permLabel(k), key: k, danger: isDangerPerm(k) });
  for (const k of revoked) changes.push({ kind: 'revoke', label: permLabel(k), key: k });
  const dormant = Object.keys(draft.permissions)
    .filter((k) => !!draft.permissions[k] !== !!state.permissions[k] && after.has(k) === before.has(k))
    .sort();
  for (const k of dormant) {
    changes.push({
      kind: 'field', label: `${permLabel(k)} (per-user, masked by role)`,
      from: state.permissions[k] ? 'on' : 'off', to: draft.permissions[k] ? 'on' : 'off',
    });
  }
  if (draft.require2fa !== !!state.require_2fa) {
    changes.push({
      kind: 'field', label: 'Enforce 2FA', from: state.require_2fa ? 'on' : 'off', to: draft.require2fa ? 'on' : 'off',
      danger: !draft.require2fa,
    });
  }
  const beforeRole = roles.find((r) => String(r.id) === baseRole);
  const afterRole = roles.find((r) => String(r.id) === draft.roleId);
  for (const q of QUOTA_KEYS) {
    const rawFrom = quotaValue(state.quotas[q.column]);
    const rawTo = quotaValue(draft.quotas[q.key]);
    const from = rawFrom ?? quotaValue(beforeRole?.[q.column]);
    const to = rawTo ?? quotaValue(afterRole?.[q.column]);
    if (from !== to || rawFrom !== rawTo) {
      const fmt = (v) => (v === null ? 'unlimited' : `${v}${q.unit}`);
      changes.push({ kind: 'field', label: q.label, from: fmt(from), to: fmt(to) });
    }
  }
  const baseVmKeys = new Set(state.vms.map(vmIdentityKey));
  for (const k of [...draft.vmKeys].filter((x) => !baseVmKeys.has(x))) {
    const vm = allVMs.find((v) => vmIdentityKey(v) === k);
    changes.push({ kind: 'grant', label: `VM ${vm ? vmLabel(vm) : k}` });
  }
  for (const a of state.vms.filter((x) => !draft.vmKeys.has(vmIdentityKey(x)))) {
    const vm = allVMs.find((v) => vmIdentityKey(v) === vmIdentityKey(a));
    changes.push({ kind: 'revoke', label: `VM ${vmLabel({ ...a, name: vm?.name })}` });
  }
  const baseVlans = new Set(state.vlan_ids);
  const vlanName = (id) => {
    const v = allVLANs.find((x) => x.id === id);
    return v ? `VLAN ${v.name} (tag ${v.tag})` : `VLAN #${id}`;
  };
  for (const id of [...draft.vlanIds].filter((x) => !baseVlans.has(x))) changes.push({ kind: 'grant', label: vlanName(id) });
  for (const id of state.vlan_ids.filter((x) => !draft.vlanIds.has(x))) changes.push({ kind: 'revoke', label: vlanName(id) });
  return changes;
}
