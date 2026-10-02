// Run with:  node --test src/utils/roleDiff.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRole, roleMatchesQuery, permLabel, isDangerPerm } from './roleDiff.js';

const role = {
  name: 'Operator', description: 'ops', permissions: ['can_manage_vlans'],
  max_cores: 8, max_memory_gb: null, max_storage_gb: 100,
};

test('an unchanged draft produces no diff', () => {
  const draft = { name: 'Operator', description: 'ops', permissions: new Set(['can_manage_vlans']), maxCores: '8', maxMemoryGb: '', maxStorageGb: 100 };
  assert.deepEqual(diffRole(role, draft), []);
});

test('grants, revokes, metadata and quota changes are all reported', () => {
  const draft = {
    name: ' Operator 2 ', description: 'ops', permissions: ['can_operate_all_vms'],
    maxCores: '', maxMemoryGb: '16', maxStorageGb: 100,
  };
  const diff = diffRole(role, draft);
  assert.deepEqual(diff, [
    { kind: 'field', label: 'Name', from: 'Operator', to: 'Operator 2' },
    { kind: 'grant', label: 'Operate all VMs', key: 'can_operate_all_vms', danger: true },
    { kind: 'revoke', label: 'Manage VLANs', key: 'can_manage_vlans' },
    { kind: 'field', label: 'Max CPU cores', from: '8', to: 'unlimited' },
    { kind: 'field', label: 'Max memory', from: 'unlimited', to: '16 GB' },
  ]);
});

test('a new role diffs against an empty baseline', () => {
  const diff = diffRole(null, { name: 'New', description: '', permissions: ['see_all_vms'], maxCores: '', maxMemoryGb: '', maxStorageGb: '' });
  assert.deepEqual(diff.map((c) => c.kind), ['field', 'grant']);
});

test('search matches name, description, permission key and label', () => {
  assert.ok(roleMatchesQuery(role, ''));
  assert.ok(roleMatchesQuery(role, 'oper'));
  assert.ok(roleMatchesQuery(role, 'OPS'));
  assert.ok(roleMatchesQuery(role, 'can_manage_vlans'));
  assert.ok(roleMatchesQuery(role, 'manage vlans'));
  assert.ok(!roleMatchesQuery(role, 'firewall'));
});

test('labels fall back to the raw key and only operate-all is dangerous', () => {
  assert.equal(permLabel('can_manage_hosts'), 'Manage PVE Hosts');
  assert.equal(permLabel('unknown_key'), 'unknown_key');
  assert.ok(isDangerPerm('can_operate_all_vms'));
  assert.ok(!isDangerPerm('see_all_vms'));
});

test('role quota validation matches the server: whole numbers or empty', async () => {
  const { isValidQuota, invalidRoleQuotaKeys } = await import('./roleDiff.js');
  for (const ok of ['', null, undefined, '0', '12', 8, ' 16 ']) assert.ok(isValidQuota(ok), `expected ${ok} to be valid`);
  for (const bad of ['1e3', '1.5', '-1', '8abc', 1.5, '2147483648']) assert.ok(!isValidQuota(bad), `expected ${bad} to be invalid`);
  assert.deepEqual(invalidRoleQuotaKeys({ maxCores: '1e3', maxMemoryGb: '', maxStorageGb: '4' }), ['maxCores']);
});
