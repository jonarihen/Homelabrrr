// Regression coverage for the role-vs-column precedence rule behind
// userHasPermission()/effectivePermissions() — see issue #71.
// Run with:  node --test src/utils/permissionRules.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissionCheck, resolveEffectivePermissions } from './permissionRules.js';

const KEYS = ['can_manage_firewalls', 'can_manage_vlans', 'see_all_vms'];

// The bug in issue #71: this user's column is 0, the role is what grants it.
const roleUser = { id: 2, is_admin: 0, role_id: 5, can_manage_firewalls: 0, can_manage_vlans: 0 };
const roleGrants = new Set(['can_manage_firewalls']);

test('a role grant counts even though the legacy column is 0', () => {
  assert.equal(resolvePermissionCheck(roleUser, roleGrants, ['can_manage_firewalls']), true);
});

test('a role that does not grant the key denies, even if the column is 1', () => {
  const user = { ...roleUser, can_manage_vlans: 1 };
  assert.equal(resolvePermissionCheck(user, roleGrants, ['can_manage_vlans']), false);
});

test('no role falls back to the legacy per-user columns', () => {
  const user = { id: 3, is_admin: 0, role_id: null, can_manage_firewalls: 1 };
  assert.equal(resolvePermissionCheck(user, null, ['can_manage_firewalls']), true);
  assert.equal(resolvePermissionCheck(user, null, ['can_manage_vlans']), false);
});

test('only an exact 1 counts in the column fallback', () => {
  for (const v of [0, '1', true, null, undefined]) {
    const user = { id: 4, is_admin: 0, role_id: null, can_manage_firewalls: v };
    assert.equal(resolvePermissionCheck(user, null, ['can_manage_firewalls']), false, String(v));
  }
});

test('admin bypasses everything, role or not', () => {
  const admin = { id: 1, is_admin: 1, role_id: null };
  assert.equal(resolvePermissionCheck(admin, null, ['can_manage_firewalls']), true);
  assert.equal(resolvePermissionCheck({ ...admin, role_id: 5 }, new Set(), ['anything']), true);
});

test('a missing user is denied', () => {
  assert.equal(resolvePermissionCheck(undefined, roleGrants, ['can_manage_firewalls']), false);
  assert.equal(resolvePermissionCheck(null, roleGrants, ['can_manage_firewalls']), false);
});

test('multiple keys pass if any one is granted', () => {
  assert.equal(resolvePermissionCheck(roleUser, roleGrants, ['can_manage_vlans', 'can_manage_firewalls']), true);
  assert.equal(resolvePermissionCheck(roleUser, roleGrants, ['can_manage_vlans', 'see_all_vms']), false);
  assert.equal(resolvePermissionCheck(roleUser, roleGrants, []), false);
});

test('role permissions may be given as an array', () => {
  assert.equal(resolvePermissionCheck(roleUser, ['can_manage_firewalls'], ['can_manage_firewalls']), true);
});

test('effective map: a role defines the whole set', () => {
  assert.deepEqual(resolveEffectivePermissions(roleUser, roleGrants, KEYS), {
    can_manage_firewalls: true,
    can_manage_vlans: false,
    see_all_vms: false,
  });
});

test('effective map: no role → the legacy columns define the set', () => {
  const user = { id: 3, is_admin: 0, role_id: null, can_manage_vlans: 1, see_all_vms: 0 };
  assert.deepEqual(resolveEffectivePermissions(user, null, KEYS), {
    can_manage_firewalls: false,
    can_manage_vlans: true,
    see_all_vms: false,
  });
});

test('effective map: is_admin is deliberately NOT folded in', () => {
  const admin = { id: 1, is_admin: 1, role_id: null };
  assert.deepEqual(resolveEffectivePermissions(admin, null, KEYS), {
    can_manage_firewalls: false,
    can_manage_vlans: false,
    see_all_vms: false,
  });
});

test('effective map: a missing user row yields all false', () => {
  assert.deepEqual(resolveEffectivePermissions(undefined, null, KEYS), {
    can_manage_firewalls: false,
    can_manage_vlans: false,
    see_all_vms: false,
  });
});
