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
  if (draft.roleId !== baseRole) body.roleId = draft.roleId === '' ? null : Number(draft.roleId);

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
  if (draft.roleId !== baseRole) {
    const newRole = roles.find((r) => String(r.id) === draft.roleId);
    const grantsDanger = !!newRole?.permissions?.some(isDangerPerm);
    changes.push({ kind: 'field', label: 'Role', from: roleName(baseRole), to: roleName(draft.roleId), danger: grantsDanger });
  }
  for (const [k, v] of Object.entries(draft.permissions).sort(([a], [b]) => a.localeCompare(b))) {
    if (!!state.permissions[k] === !!v) continue;
    changes.push(v
      ? { kind: 'grant', label: permLabel(k), key: k, danger: isDangerPerm(k) }
      : { kind: 'revoke', label: permLabel(k), key: k });
  }
  if (draft.require2fa !== !!state.require_2fa) {
    changes.push({
      kind: 'field', label: 'Enforce 2FA', from: state.require_2fa ? 'on' : 'off', to: draft.require2fa ? 'on' : 'off',
      danger: !draft.require2fa,
    });
  }
  for (const q of QUOTA_KEYS) {
    const from = quotaValue(state.quotas[q.column]);
    const to = quotaValue(draft.quotas[q.key]);
    if (from !== to) {
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
