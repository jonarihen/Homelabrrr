// Clone, holder listing, and the reassign-on-delete path for /api/admin/roles.
// Run with:  node --test src/routes/adminRoleClone.test.ts   (from backend/)
//
// Cloning has to copy permissions and quotas without ever producing a second
// built-in role, and the delete route has to move its holders onto the
// replacement role (or to no role) in the same transaction as the delete.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, roles, rolePermissions, auditLog } from '../db/schema/index.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let adminId: number;

const SOURCE = {
  name: 'operators',
  description: 'the source role',
  permissions: ['can_manage_vlans', 'can_manage_policies'],
  max_cores: 8,
  max_memory_gb: 16,
  max_storage_gb: null as number | null,
};

async function createRole(values: Record<string, unknown>, permissions: string[] = []) {
  const [row] = await testDb.db.insert(roles).values(values as never).returning({ id: roles.id });
  if (permissions.length > 0) {
    await testDb.db.insert(rolePermissions)
      .values(permissions.map((permission) => ({ role_id: row.id, permission })));
  }
  return row.id;
}

async function permissionsOf(roleId: number) {
  const rows = await testDb.db.select({ permission: rolePermissions.permission })
    .from(rolePermissions).where(eq(rolePermissions.role_id, roleId));
  return rows.map((r) => r.permission).sort();
}

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [admin] = await testDb.db.insert(users)
    .values({ username: 'clone-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });
  adminId = admin.id;

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Role mutations sit behind requireRecentReauthentication — stamp the
    // session as freshly re-authenticated so the route itself is what's tested.
    req.session = {
      userId: adminId, username: 'clone-admin', isAdmin: true, reauthenticatedAt: Date.now(),
    } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

// Each test starts from one source role and no other roles or holders, so the
// generated `(copy)` names are predictable.
let sourceId: number;
beforeEach(async () => {
  await testDb.db.delete(users).where(inArray(users.username, ['holder-a', 'holder-b']));
  await testDb.db.delete(roles);
  await testDb.db.delete(auditLog);
  sourceId = await createRole({
    name: SOURCE.name,
    description: SOURCE.description,
    max_cores: SOURCE.max_cores,
    max_memory_gb: SOURCE.max_memory_gb,
    max_storage_gb: SOURCE.max_storage_gb,
  }, SOURCE.permissions);
});

test('an empty clone body copies permissions, quotas and description', async () => {
  const res = await request(app).post(`/roles/${sourceId}/clone`).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'operators (copy)');
  assert.equal(res.body.description, SOURCE.description);
  assert.deepEqual([...res.body.permissions].sort(), [...SOURCE.permissions].sort());
  assert.equal(res.body.max_cores, SOURCE.max_cores);
  assert.equal(res.body.max_memory_gb, SOURCE.max_memory_gb);
  assert.equal(res.body.max_storage_gb, null, 'an unlimited quota stays unlimited');
  assert.equal(res.body.userCount, 0, 'a clone starts with no holders');
  assert.notEqual(res.body.id, sourceId);

  assert.deepEqual(await permissionsOf(res.body.id), [...SOURCE.permissions].sort());

  const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'admin_clone_role'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].target, 'operators (copy)');
  assert.match(audits[0].detail ?? '', /from=operators/);
});

test('a clone request with no body at all is a straight copy', async () => {
  // express 5 hands the route an undefined body when nothing was posted.
  const res = await request(app).post(`/roles/${sourceId}/clone`);

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'operators (copy)');
  assert.deepEqual([...res.body.permissions].sort(), [...SOURCE.permissions].sort());
  assert.equal(res.body.max_cores, SOURCE.max_cores);
});

test('the generated name steps past names that are already taken', async () => {
  const first = await request(app).post(`/roles/${sourceId}/clone`).send({});
  assert.equal(first.body.name, 'operators (copy)');
  const second = await request(app).post(`/roles/${sourceId}/clone`).send({});
  assert.equal(second.status, 200);
  assert.equal(second.body.name, 'operators (copy 2)');
  const third = await request(app).post(`/roles/${sourceId}/clone`).send({});
  assert.equal(third.body.name, 'operators (copy 3)');
});

test('cloning a built-in role produces an ordinary editable role', async () => {
  const builtInId = await createRole(
    { name: 'built-in-source', description: 'fixed', built_in: true }, ['see_all_vms'],
  );

  const res = await request(app).post(`/roles/${builtInId}/clone`).send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.builtIn, false, 'the clone must not inherit built_in');
  assert.deepEqual(res.body.permissions, ['see_all_vms']);

  const [row] = await testDb.db.select().from(roles).where(eq(roles.id, res.body.id)).limit(1);
  assert.equal(row.built_in, false);

  // ...and being an ordinary role, it can be renamed.
  const renamed = await request(app).put(`/roles/${res.body.id}`).send({ name: 'renamed-clone' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'renamed-clone');
});

test('clone overrides replace only the fields they carry', async () => {
  const res = await request(app).post(`/roles/${sourceId}/clone`).send({
    name: 'operators-lite', description: 'trimmed down',
    permissions: ['can_manage_vlans'], maxMemoryGb: 4,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'operators-lite');
  assert.equal(res.body.description, 'trimmed down');
  assert.deepEqual(res.body.permissions, ['can_manage_vlans']);
  assert.equal(res.body.max_memory_gb, 4, 'the supplied quota wins');
  assert.equal(res.body.max_cores, SOURCE.max_cores, 'an untouched quota still comes from the source');
});

test('a rejected clone writes nothing at all', async () => {
  for (const body of [
    { permissions: ['not_a_permission'] },
    { maxCores: -1 },
    { name: '   ' },
  ]) {
    const res = await request(app).post(`/roles/${sourceId}/clone`).send(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} should be rejected`);
  }

  const rows = await testDb.db.select({ id: roles.id }).from(roles);
  assert.equal(rows.length, 1, 'no partial clone should have been inserted');
  assert.equal(
    (await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'admin_clone_role'))).length, 0,
    'a rejected clone must not be audited',
  );
});

test('an explicit name that is already taken is a duplicate, not a silent rename', async () => {
  const res = await request(app).post(`/roles/${sourceId}/clone`).send({ name: SOURCE.name });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /already exists/);
  assert.equal((await testDb.db.select({ id: roles.id }).from(roles)).length, 1);
});

test('cloning a role that does not exist is a 404', async () => {
  assert.equal((await request(app).post('/roles/999999/clone').send({})).status, 404);
  assert.equal((await request(app).post('/roles/not-a-number/clone').send({})).status, 404);
});

test('the holder list names the users who hold the role', async () => {
  await testDb.db.insert(users).values([
    { username: 'holder-b', password: 'x', role_id: sourceId },
    { username: 'holder-a', password: 'x', role_id: sourceId },
  ] as never);

  const res = await request(app).get(`/roles/${sourceId}/users`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.users.map((u: { username: string }) => u.username), ['holder-a', 'holder-b']);

  const other = await createRole({ name: 'nobody-holds-this' });
  assert.deepEqual((await request(app).get(`/roles/${other}/users`)).body.users, []);
  assert.equal((await request(app).get('/roles/999999/users')).status, 404);
  assert.equal((await request(app).get('/roles/not-a-number/users')).status, 404);
});

test('deleting without reassignTo drops the holders to no role', async () => {
  await testDb.db.insert(users).values({ username: 'holder-a', password: 'x', role_id: sourceId } as never);

  const res = await request(app).delete(`/roles/${sourceId}`);

  assert.equal(res.status, 200);
  const [holder] = await testDb.db.select({ role_id: users.role_id })
    .from(users).where(eq(users.username, 'holder-a')).limit(1);
  assert.equal(holder.role_id, null);
  assert.equal((await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.id, sourceId))).length, 0);

  const [audit] = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'admin_delete_role'));
  assert.equal(audit.detail, '', 'a plain delete keeps its empty audit details');
});

test('deleting with reassignTo moves the holders onto the replacement role', async () => {
  const targetId = await createRole({ name: 'replacement' }, ['see_all_vms']);
  await testDb.db.insert(users).values([
    { username: 'holder-a', password: 'x', role_id: sourceId },
    { username: 'holder-b', password: 'x', role_id: sourceId },
  ] as never);

  const res = await request(app).delete(`/roles/${sourceId}?reassignTo=${targetId}`);

  assert.equal(res.status, 200);
  const holders = await testDb.db.select({ username: users.username, role_id: users.role_id })
    .from(users).where(inArray(users.username, ['holder-a', 'holder-b']));
  for (const holder of holders) {
    assert.equal(holder.role_id, targetId, `${holder.username} should now hold the replacement role`);
  }
  assert.equal((await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.id, sourceId))).length, 0);

  const [audit] = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'admin_delete_role'));
  assert.match(audit.detail ?? '', /reassigned to replacement/);
});

test('a bad reassignTo rejects the delete outright', async () => {
  await testDb.db.insert(users).values({ username: 'holder-a', password: 'x', role_id: sourceId } as never);

  for (const query of [`?reassignTo=999999`, `?reassignTo=${sourceId}`, '?reassignTo=not-a-number']) {
    const res = await request(app).delete(`/roles/${sourceId}${query}`);
    assert.equal(res.status, 400, `${query} should be rejected`);
  }

  assert.equal(
    (await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.id, sourceId))).length, 1,
    'the role must survive a rejected delete',
  );
  const [holder] = await testDb.db.select({ role_id: users.role_id })
    .from(users).where(eq(users.username, 'holder-a')).limit(1);
  assert.equal(holder.role_id, sourceId, 'and its holders must keep it');
});

test('an empty reassignTo behaves like no reassignment at all', async () => {
  await testDb.db.insert(users).values({ username: 'holder-a', password: 'x', role_id: sourceId } as never);

  assert.equal((await request(app).delete(`/roles/${sourceId}?reassignTo=`)).status, 200);
  const [holder] = await testDb.db.select({ role_id: users.role_id })
    .from(users).where(eq(users.username, 'holder-a')).limit(1);
  assert.equal(holder.role_id, null);
});
