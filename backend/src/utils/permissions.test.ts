// DB-backed coverage for the role-vs-column precedence wrappers around
// permissionRules.ts — the PostgreSQL `users` flags are real booleans, and
// permissions.ts must translate them for the pure rule module (issue #71:
// a role grant must win over the legacy per-user columns).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, roles, rolePermissions } from '../db/schema/index.ts';

// permissions.ts reads through the singleton db (src/db/client.ts), which
// reads DATABASE_URL at import time — so both are imported dynamically
// after the throwaway database exists.
let testDb: TestDatabase;
let permissions: typeof import('./permissions.ts');
let closeDb: (() => Promise<void>) | undefined;

let roleUserId: number; // has a role granting can_manage_firewalls; columns say otherwise
let columnUserId: number; // no role; can_manage_firewalls via the legacy column
let adminUserId: number; // is_admin, nothing else
let roleId: number;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  ({ closeDb } = await import('../db/client.ts'));
  permissions = await import('./permissions.ts');

  [{ id: roleId }] = await testDb.db
    .insert(roles)
    .values({ name: 'Firewall Operator' })
    .returning({ id: roles.id });
  await testDb.db.insert(rolePermissions).values({ role_id: roleId, permission: 'can_manage_firewalls' });

  // The issue-#71 shape: the role grants firewalls, while the user's own
  // columns grant vlans (which the role must override into a denial).
  [{ id: roleUserId }] = await testDb.db
    .insert(users)
    .values({
      username: 'role-user', password: 'x', role_id: roleId,
      can_manage_firewalls: false, can_manage_vlans: true,
    })
    .returning({ id: users.id });
  [{ id: columnUserId }] = await testDb.db
    .insert(users)
    .values({ username: 'column-user', password: 'x', can_manage_firewalls: true })
    .returning({ id: users.id });
  [{ id: adminUserId }] = await testDb.db
    .insert(users)
    .values({ username: 'admin-user', password: 'x', is_admin: true })
    .returning({ id: users.id });
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

async function loadUser(id: number) {
  const [row] = await testDb.db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

test('getRolePermissions returns the granted set, empty for no role', async () => {
  assert.deepEqual(await permissions.getRolePermissions(roleId), new Set(['can_manage_firewalls']));
  assert.deepEqual(await permissions.getRolePermissions(null), new Set());
  assert.deepEqual(await permissions.getRolePermissions(undefined), new Set());
});

test('a role grant counts even though the boolean column is false', async () => {
  assert.equal(await permissions.userHasPermission(roleUserId, 'can_manage_firewalls'), true);
});

test('a role that does not grant the key denies, even if the column is true', async () => {
  assert.equal(await permissions.userHasPermission(roleUserId, 'can_manage_vlans'), false);
});

test('no role falls back to the boolean per-user columns', async () => {
  assert.equal(await permissions.userHasPermission(columnUserId, 'can_manage_firewalls'), true);
  assert.equal(await permissions.userHasPermission(columnUserId, 'can_manage_vlans'), false);
});

test('admin bypasses everything; a missing user is denied', async () => {
  assert.equal(await permissions.userHasPermission(adminUserId, 'can_manage_firewalls'), true);
  assert.equal(await permissions.userHasPermission(999999, 'can_manage_firewalls'), false);
});

test('multiple keys pass if any one is granted', async () => {
  assert.equal(
    await permissions.userHasPermission(roleUserId, 'can_manage_vlans', 'can_manage_firewalls'),
    true,
  );
  assert.equal(await permissions.userHasPermission(roleUserId, 'can_manage_vlans', 'see_all_vms'), false);
});

test('effective map: a role defines the whole set', async () => {
  const map = await permissions.effectivePermissions(await loadUser(roleUserId));
  assert.equal(map.can_manage_firewalls, true);
  assert.equal(map.can_manage_vlans, false); // the true column is ignored
  assert.equal(map.see_all_vms, false);
});

test('effective map: no role → the boolean columns define the set', async () => {
  const map = await permissions.effectivePermissions(await loadUser(columnUserId));
  assert.equal(map.can_manage_firewalls, true);
  assert.equal(map.can_manage_vlans, false);
});

test('effective map: is_admin is deliberately NOT folded in; missing row yields all false', async () => {
  const adminMap = await permissions.effectivePermissions(await loadUser(adminUserId));
  assert.equal(Object.values(adminMap).some(Boolean), false);
  const emptyMap = await permissions.effectivePermissions(undefined);
  assert.equal(Object.values(emptyMap).some(Boolean), false);
  assert.equal(Object.keys(emptyMap).length, permissions.PERMISSION_KEYS.length);
});
