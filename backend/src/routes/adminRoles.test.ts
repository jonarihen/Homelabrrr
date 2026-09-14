// PUT /api/admin/roles/:id is all-or-nothing.
// Run with:  node --test src/routes/adminRoles.test.ts   (from backend/)
//
// The route used to write role metadata and replace the permission set before
// it validated the quota fields, so a request carrying good permissions and a
// bad quota answered 400 *after* it had already changed the live permissions of
// every role holder — and skipped the audit entry on the way out. Every
// rejection below must leave metadata, permissions and quotas exactly as they
// were; the accepted request must apply all three and still audit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, roles, rolePermissions, auditLog } from '../db/schema/index.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let roleId: number;

// The role's starting state — every rejection has to leave this untouched.
const START = {
  name: 'atomic-role',
  description: 'before',
  permissions: ['can_manage_vlans'],
  max_cores: 8,
  max_memory_gb: 16,
  max_storage_gb: 64,
};

async function readRole() {
  const [row] = await testDb.db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  const perms = await testDb.db.select({ permission: rolePermissions.permission })
    .from(rolePermissions).where(eq(rolePermissions.role_id, roleId));
  return { row, permissions: perms.map((p) => p.permission).sort() };
}

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [admin] = await testDb.db
    .insert(users)
    .values({ username: 'roles-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });

  const [role] = await testDb.db.insert(roles).values({
    name: START.name,
    description: START.description,
    max_cores: START.max_cores,
    max_memory_gb: START.max_memory_gb,
    max_storage_gb: START.max_storage_gb,
  }).returning({ id: roles.id });
  roleId = role.id;
  await testDb.db.insert(rolePermissions)
    .values(START.permissions.map((permission) => ({ role_id: roleId, permission })));

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Role mutations sit behind requireRecentReauthentication — stamp the
    // session as freshly re-authenticated so the route itself is what's tested.
    req.session = {
      userId: admin.id, username: 'roles-admin', isAdmin: true, reauthenticatedAt: Date.now(),
    } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('a valid permission list with an invalid quota changes nothing', async () => {
  const res = await request(app)
    .put(`/roles/${roleId}`)
    .send({ permissions: ['can_manage_hosts'], maxCores: -1 });

  assert.equal(res.status, 400);

  const { row, permissions } = await readRole();
  assert.deepEqual(
    permissions, START.permissions,
    'the rejected request must not have replaced the permission set',
  );
  assert.equal(row.max_cores, START.max_cores);
  assert.equal(row.max_memory_gb, START.max_memory_gb);
  assert.equal(row.max_storage_gb, START.max_storage_gb);
});

test('new metadata with an invalid permission list changes nothing', async () => {
  const res = await request(app)
    .put(`/roles/${roleId}`)
    .send({ name: 'renamed', description: 'after', permissions: ['can_manage_hosts', 'not_a_permission'] });

  assert.equal(res.status, 400);

  const { row, permissions } = await readRole();
  assert.equal(row.name, START.name, 'the rejected request must not have renamed the role');
  assert.equal(row.description, START.description);
  assert.deepEqual(permissions, START.permissions);
});

test('new metadata and permissions with an invalid quota change nothing', async () => {
  const res = await request(app)
    .put(`/roles/${roleId}`)
    .send({
      name: 'renamed', description: 'after',
      permissions: ['can_manage_hosts'],
      maxCores: 4, maxMemoryGb: 'not-a-number',
    });

  assert.equal(res.status, 400);

  const { row, permissions } = await readRole();
  assert.equal(row.name, START.name);
  assert.equal(row.description, START.description);
  assert.deepEqual(permissions, START.permissions);
  assert.equal(row.max_cores, START.max_cores);
  assert.equal(row.max_memory_gb, START.max_memory_gb);
});

test('a fully valid update applies every field and audits it', async () => {
  const res = await request(app)
    .put(`/roles/${roleId}`)
    .send({
      name: 'atomic-role-renamed', description: 'after',
      permissions: ['can_manage_hosts', 'can_manage_users'],
      maxCores: 4, maxMemoryGb: 8, maxStorageGb: null,
    });

  assert.equal(res.status, 200);
  assert.deepEqual([...res.body.permissions].sort(), ['can_manage_hosts', 'can_manage_users']);

  const { row, permissions } = await readRole();
  assert.equal(row.name, 'atomic-role-renamed');
  assert.equal(row.description, 'after');
  assert.deepEqual(permissions, ['can_manage_hosts', 'can_manage_users']);
  assert.equal(row.max_cores, 4);
  assert.equal(row.max_memory_gb, 8);
  assert.equal(row.max_storage_gb, null, 'an empty quota means unlimited');

  const audits = await testDb.db.select().from(auditLog)
    .where(eq(auditLog.action, 'admin_update_role'));
  assert.equal(audits.length, 1, 'only the successful update should have been audited');
  assert.equal(audits[0].target, START.name, 'the audit records the role as it was named going in');
});
