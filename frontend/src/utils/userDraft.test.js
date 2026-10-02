// Run with:  node --test src/utils/userDraft.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftFromState, buildUserPatch, describeUserChanges } from './userDraft.js';

const state = {
  id: 5,
  username: 'alice',
  version: 'v1',
  role_id: null,
  permissions: { see_all_vms: false, can_operate_all_vms: false, can_manage_hosts: true },
  require_2fa: true,
  quotas: { max_cores: 4, max_memory_gb: null, max_storage_gb: null },
  vms: [{ id: 11, node: '1~pve', vmid: 100 }],
  vlan_ids: [3],
};
const allVMs = [
  { vmid: 100, node: 'pve', nodeRef: '1~pve', name: 'web' },
  { vmid: 101, node: 'pve', nodeRef: '1~pve', name: 'db' },
];
const allVLANs = [{ id: 3, name: 'lab', tag: 30 }, { id: 4, name: 'dmz', tag: 40 }];
const roles = [{ id: 9, name: 'Ops', permissions: ['can_operate_all_vms'] }, { id: 10, name: 'Viewer', permissions: ['see_all_vms'] }];

test('an untouched draft builds no patch and no changes', () => {
  const d = draftFromState(state);
  assert.equal(buildUserPatch(state, d, { allVMs }), null);
  assert.deepEqual(describeUserChanges(state, d, { allVMs, allVLANs, roles }), []);
});

test('every staged section ends up in one patch with the version', () => {
  const d = draftFromState(state);
  d.roleId = '10';
  d.permissions.can_operate_all_vms = true;
  d.permissions.can_manage_hosts = false;
  d.require2fa = false;
  d.quotas.maxCores = '';
  d.vmKeys.delete('1~pve-100');
  d.vmKeys.add('1~pve-101');
  d.vlanIds.delete(3);
  d.vlanIds.add(4);
  assert.deepEqual(buildUserPatch(state, d, { allVMs }), {
    version: 'v1',
    roleId: 10,
    permissions: { can_operate_all_vms: true, can_manage_hosts: false },
    require2fa: false,
    quotas: { maxCores: '', maxMemoryGb: '', maxStorageGb: '' },
    vms: { add: [{ node: '1~pve', vmid: 101 }], remove: [11] },
    vlans: { add: [4], remove: [3] },
  });
});

test('toggling back to the original value cancels the change', () => {
  const d = draftFromState(state);
  d.permissions.can_manage_hosts = false;
  d.permissions.can_manage_hosts = true;
  d.quotas.maxCores = '4';
  assert.equal(buildUserPatch(state, d, { allVMs }), null);
});

test('the review list flags dangerous changes', () => {
  const d = draftFromState(state);
  d.permissions.can_operate_all_vms = true;
  d.require2fa = false;
  d.roleId = '9';
  d.vmKeys.add('1~pve-101');
  const changes = describeUserChanges(state, d, { allVMs, allVLANs, roles });
  const danger = changes.filter((c) => c.danger).map((c) => c.label);
  assert.deepEqual(danger.sort(), ['Enforce 2FA', 'Operate all VMs', 'Role']);
  assert.ok(changes.some((c) => c.kind === 'grant' && c.label === 'VM db (pve · 101)'));
});

test('a role without risky permissions is not flagged', () => {
  const d = draftFromState(state);
  d.roleId = '10';
  const [change] = describeUserChanges(state, d, { allVMs, allVLANs, roles });
  assert.deepEqual(change, { kind: 'field', label: 'Role', from: 'No role', to: 'Viewer', danger: false });
});
