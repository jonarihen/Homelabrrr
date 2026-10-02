// Role management quality-of-life routes (#201): clone, holders list, bulk
// assign, and delete with reassignment.
// Run with:  node --test src/routes/adminRoleManagement.test.ts   (from backend/)
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
let builtInId: number;
let sourceId: number;
let alice: number;
let bob: number;
let carol: number;

async function permsOf(roleId: number) {
  const rows = await testDb.db.select({ permission: rolePermissions.permission })
    .from(rolePermissions).where(eq(rolePermissions.role_id, roleId));
  return rows.map((r) => r.permission).sort();
}

async function roleOf(userId: number) {
  const [row] = await testDb.db.select({ role_id: users.role_id }).from(users).where(eq(users.id, userId));
  return row.role_id;
}

async function makeRole(name: string, permissions: string[] = [], extra = {}) {
  const [row] = await testDb.db.insert(roles).values({ name, ...extra }).returning({ id: roles.id });
  if (permissions.length) {
    await testDb.db.insert(rolePermissions).values(permissions.map((permission) => ({ role_id: row.id, permission })));
  }
  return row.id;
}

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [admin] = await testDb.db.insert(users)
    .values({ username: 'qol-admin', password: 'x', is_admin: true }).returning({ id: users.id });

  builtInId = await makeRole('Builtin', ['can_view_audit_log'], { built_in: true, description: 'fixed' });
  sourceId = await makeRole('Operator', ['can_manage_vlans', 'can_operate_all_vms'], {
    description: 'ops team', max_cores: 8, max_memory_gb: 16, max_storage_gb: 200,
  });
  [{ id: alice }, { id: bob }, { id: carol }] = await testDb.db.insert(users).values([
    { username: 'alice', password: 'x', role_id: sourceId },
    { username: 'bob', password: 'x', role_id: sourceId },
    { username: 'carol', password: 'x' },
  ]).returning({ id: users.id });

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      userId: admin.id, username: 'qol-admin', isAdmin: true, reauthenticatedAt: Date.now(),
    } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('clone copies permissions, quotas and description under a "(copy)" name', async () => {
  const res = await request(app).post(`/roles/${sourceId}/clone`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Operator (copy)');
  assert.equal(res.body.description, 'ops team');
  assert.equal(res.body.max_cores, 8);
  assert.equal(res.body.max_memory_gb, 16);
  assert.equal(res.body.max_storage_gb, 200);
  assert.equal(res.body.builtIn, false);
  assert.equal(res.body.userCount, 0, 'holders are not copied');
  assert.deepEqual(await permsOf(res.body.id), ['can_manage_vlans', 'can_operate_all_vms']);

  const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'admin_clone_role'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].target, 'Operator (copy)');
});

test('repeated clones pick the next free copy name', async () => {
  const res = await request(app).post(`/roles/${sourceId}/clone`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Operator (copy 2)');
});

test('clone accepts an explicit name and rejects a duplicate', async () => {
  const ok = await request(app).post(`/roles/${sourceId}/clone`).send({ name: 'Operator Lite' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'Operator Lite');

  const dup = await request(app).post(`/roles/${sourceId}/clone`).send({ name: 'Operator Lite' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists/);
});

test('a built-in role clones into a regular role', async () => {
  const res = await request(app).post(`/roles/${builtInId}/clone`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.builtIn, false);
  assert.deepEqual(await permsOf(res.body.id), ['can_view_audit_log']);
});

test('clone and holders answer 404 for unknown or malformed ids', async () => {
  assert.equal((await request(app).post('/roles/999999/clone').send({})).status, 404);
  assert.equal((await request(app).post('/roles/abc/clone').send({})).status, 404);
  assert.equal((await request(app).get('/roles/abc/users')).status, 404);
  assert.equal((await request(app).delete('/roles/abc')).status, 404);
  assert.equal((await request(app).put('/roles/abc').send({})).status, 404);
});

test('the holders endpoint lists users holding the role', async () => {
  const res = await request(app).get(`/roles/${sourceId}/users`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((u) => u.username), ['alice', 'bob']);
});

test('bulk assign moves every listed user and audits each change', async () => {
  const target = await makeRole('Bulk Target');
  const res = await request(app).post(`/roles/${target}/assign`).send({ userIds: [alice, carol] });
  assert.equal(res.status, 200);
  assert.equal(res.body.assigned, 2);
  assert.equal(await roleOf(alice), target);
  assert.equal(await roleOf(carol), target);
  assert.equal(await roleOf(bob), sourceId, 'unlisted users are untouched');

  const again = await request(app).post(`/roles/${target}/assign`).send({ userIds: [alice] });
  assert.equal(again.body.assigned, 0, 'users already holding the role are not re-audited');

  await testDb.db.update(users).set({ role_id: sourceId }).where(eq(users.id, alice));
  await testDb.db.update(users).set({ role_id: null }).where(eq(users.id, carol));
});

test('bulk assign with an unknown user changes nothing', async () => {
  const target = await makeRole('Bulk Reject');
  const res = await request(app).post(`/roles/${target}/assign`).send({ userIds: [carol, 999999] });
  assert.equal(res.status, 400);
  assert.equal(await roleOf(carol), null);

  assert.equal((await request(app).post(`/roles/${target}/assign`).send({ userIds: [] })).status, 400);
  assert.equal((await request(app).post(`/roles/${target}/assign`).send({ userIds: ['x'] })).status, 400);
});

test('delete with reassignTo moves holders to the target role', async () => {
  const doomed = await makeRole('Doomed', ['can_manage_hosts']);
  const heir = await makeRole('Heir');
  await testDb.db.update(users).set({ role_id: doomed }).where(eq(users.id, carol));

  const res = await request(app).delete(`/roles/${doomed}?reassignTo=${heir}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.reassigned, 1);
  assert.equal(await roleOf(carol), heir);
  const [gone] = await testDb.db.select().from(roles).where(eq(roles.id, doomed));
  assert.equal(gone, undefined);
});

test('delete without reassignTo unassigns holders', async () => {
  const doomed = await makeRole('Doomed 2');
  await testDb.db.update(users).set({ role_id: doomed }).where(eq(users.id, carol));
  const res = await request(app).delete(`/roles/${doomed}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.unassigned, 1);
  assert.equal(await roleOf(carol), null);
});

test('delete with an invalid reassignment target changes nothing', async () => {
  const doomed = await makeRole('Doomed 3');
  await testDb.db.update(users).set({ role_id: doomed }).where(eq(users.id, carol));

  assert.equal((await request(app).delete(`/roles/${doomed}?reassignTo=999999`)).status, 400);
  assert.equal((await request(app).delete(`/roles/${doomed}?reassignTo=${doomed}`)).status, 400);
  assert.equal(await roleOf(carol), doomed, 'holders keep the role when the delete is rejected');
  const [still] = await testDb.db.select().from(roles).where(eq(roles.id, doomed));
  assert.ok(still, 'the role survives a rejected delete');
});

test('built-in roles still cannot be deleted', async () => {
  const res = await request(app).delete(`/roles/${builtInId}`);
  assert.equal(res.status, 400);
});
