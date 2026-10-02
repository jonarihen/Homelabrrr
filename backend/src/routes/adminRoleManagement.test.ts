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

test('concurrent automatic clones get different names instead of a collision error', async () => {
  const [a, b] = await Promise.all([
    request(app).post(`/roles/${builtInId}/clone`).send({}),
    request(app).post(`/roles/${builtInId}/clone`).send({}),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.body.name, b.body.name);
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

test('ids beyond the PostgreSQL integer range answer 404/400, not 500', async () => {
  const huge = '2147483648';
  assert.equal((await request(app).post(`/roles/${huge}/clone`).send({})).status, 404);
  assert.equal((await request(app).get(`/roles/${huge}/users`)).status, 404);
  assert.equal((await request(app).put(`/roles/${huge}`).send({})).status, 404);
  assert.equal((await request(app).delete(`/roles/${huge}`)).status, 404);
  assert.equal((await request(app).delete(`/roles/${sourceId}?reassignTo=${huge}`)).status, 400);
  assert.equal((await request(app).post(`/roles/${sourceId}/assign`).send({ userIds: [2147483648] })).status, 400);
  assert.equal((await request(app).post(`/roles/${sourceId}/assign`).send({ userIds: [Number.MAX_SAFE_INTEGER + 2] })).status, 400);
  assert.equal((await request(app).post(`/roles/${sourceId}/assign`).send({ userIds: [0] })).status, 400);
});

test('role history follows the role id across renames', async () => {
  const id = await makeRole('History Before');
  await request(app).put(`/roles/${id}`).send({ name: 'History After' }).expect(200);
  await request(app).post(`/roles/${id}/assign`).send({ userIds: [carol] }).expect(200);

  const res = await request(app).get('/audit-log').query({ targetRef: `role:${id}` });
  assert.equal(res.status, 200);
  const actions = res.body.rows.map((r) => r.action).sort();
  assert.deepEqual(actions, ['admin_assign_role', 'admin_update_role']);
  const update = res.body.rows.find((r) => r.action === 'admin_update_role');
  assert.equal(update.target, 'History Before');
  assert.match(update.detail, /renamed to: History After/);

  await testDb.db.update(users).set({ role_id: null }).where(eq(users.id, carol));
  await request(app).delete(`/roles/${id}`).expect(200);
  const reused = await makeRole('History After');
  const fresh = await request(app).get('/audit-log').query({ targetRef: `role:${reused}` });
  assert.equal(fresh.body.rows.length, 0, 'a reused name does not inherit the old role\'s history');
});

test('clone reads the source inside its transaction', async () => {
  const id = await makeRole('Racy', ['can_manage_hosts']);
  const { db } = await import('../db/client.ts');
  const tx = db.transaction(async (t) => {
    await t.select().from(roles).where(eq(roles.id, id)).for('update');
    await new Promise((r) => setTimeout(r, 300));
    await t.delete(roles).where(eq(roles.id, id));
  });
  await new Promise((r) => setTimeout(r, 50));
  const res = await request(app).post(`/roles/${id}/clone`).send({});
  await tx;
  assert.equal(res.status, 404, 'a source deleted mid-clone must not produce an empty copy');
  const leftovers = await testDb.db.select().from(roles).where(eq(roles.name, 'Racy (copy)'));
  assert.equal(leftovers.length, 0);
});

test('a concurrent assignment cannot slip past a reassigning delete', async () => {
  const doomed = await makeRole('Doomed Race');
  const heir = await makeRole('Heir Race');
  const { db } = await import('../db/client.ts');
  // An uncommitted assignment into the doomed role, held open across the
  // delete request. Without the delete's FOR UPDATE on the role, the holder
  // UPDATE skips carol (her new role_id isn't visible yet) and the DELETE
  // later nulls her via ON DELETE SET NULL. With the lock, the delete waits
  // for this transaction and then sees and moves her.
  let release;
  const gate = new Promise((r) => { release = r; });
  const assignTx = db.transaction(async (tx) => {
    await tx.update(users).set({ role_id: doomed }).where(eq(users.id, carol));
    await gate;
  });
  await new Promise((r) => setTimeout(r, 50));
  const del = request(app).delete(`/roles/${doomed}?reassignTo=${heir}`).then((r) => r);
  await new Promise((r) => setTimeout(r, 200));
  release();
  await assignTx;
  const res = await del;
  assert.equal(res.status, 200);
  assert.equal(await roleOf(carol), heir, 'the concurrently-assigned holder is moved to the heir, not left role-less');
  await testDb.db.update(users).set({ role_id: null }).where(eq(users.id, carol));
});

test('moving a user between roles is recorded in both roles\' history', async () => {
  const from = await makeRole('Move From');
  const to = await makeRole('Move To');
  await testDb.db.update(users).set({ role_id: from }).where(eq(users.id, carol));

  await request(app).post(`/roles/${to}/assign`).send({ userIds: [carol] }).expect(200);
  const fromHistory = await request(app).get('/audit-log').query({ targetRef: `role:${from}` });
  assert.deepEqual(fromHistory.body.rows.map((r) => [r.action, r.target]), [['admin_unassign_role', 'carol']]);

  await request(app).put(`/users/${carol}/role`).send({ roleId: null }).expect(200);
  const toHistory = await request(app).get('/audit-log').query({ targetRef: `role:${to}` });
  assert.deepEqual(toHistory.body.rows.map((r) => r.action).sort(), ['admin_assign_role', 'admin_unassign_role']);
});

test('role quotas reject fractional and exponent values instead of truncating', async () => {
  const id = await makeRole('Quota Strict', [], { max_cores: 2 });
  for (const maxCores of ['1e3', '1.5', '8abc']) {
    const res = await request(app).put(`/roles/${id}`).send({ maxCores, maxMemoryGb: '', maxStorageGb: '' });
    assert.equal(res.status, 400, `expected 400 for ${maxCores}`);
  }
  const [row] = await testDb.db.select().from(roles).where(eq(roles.id, id));
  assert.equal(row.max_cores, 2);
});

test('a stale holder count aborts a role edit before changing permissions', async () => {
  const doomed = await makeRole('Edit Count', ['can_manage_hosts']);
  await testDb.db.update(users).set({ role_id: doomed }).where(eq(users.id, carol));
  const res = await request(app).put(`/roles/${doomed}`).send({
    permissions: ['can_operate_all_vms'], expectedHolders: 0,
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await permsOf(doomed), ['can_manage_hosts']);
  assert.equal(await roleOf(carol), doomed);
  await testDb.db.update(users).set({ role_id: null }).where(eq(users.id, carol));
});

test('delete logs each holder leaving the old role', async () => {
  const doomed = await makeRole('Audit Delete');
  await testDb.db.update(users).set({ role_id: doomed }).where(eq(users.id, carol));
  const res = await request(app).delete(`/roles/${doomed}?expectedHolders=1`);
  assert.equal(res.status, 200);
  const history = await request(app).get('/audit-log').query({ targetRef: `role:${doomed}` });
  assert.ok(history.body.rows.some((r) => r.action === 'admin_unassign_role' && r.target === 'carol'));
});

test('a stale holder count aborts deletion without unassigning anyone', async () => {
  const doomed = await makeRole('Count Stale');
  await testDb.db.update(users).set({ role_id: doomed }).where(eq(users.id, carol));
  const res = await request(app).delete(`/roles/${doomed}?expectedHolders=0`);
  assert.equal(res.status, 409);
  assert.equal(await roleOf(carol), doomed);
  const [still] = await testDb.db.select().from(roles).where(eq(roles.id, doomed));
  assert.ok(still);
  const ok = await request(app).delete(`/roles/${doomed}?expectedHolders=1`);
  assert.equal(ok.status, 200);
  assert.equal(await roleOf(carol), null);
});

test('legacy role audit rows are listed separately from stable-id history', async () => {
  await testDb.db.insert(auditLog).values({ username: 'old-admin', action: 'admin_create_role', target: 'Operator', detail: 'legacy' });
  const history = await request(app).get('/audit-log').query({ targetRef: `role:${sourceId}` });
  assert.ok(history.body.rows.every((r) => r.target_ref === `role:${sourceId}`));
  const legacy = await request(app).get('/audit-log').query({ target: 'Operator', legacy: true });
  assert.ok(legacy.body.rows.some((r) => r.detail === 'legacy' && r.target_ref === null));
  assert.ok(legacy.body.rows.every((r) => r.target_ref === null));
});

test('built-in roles still cannot be deleted', async () => {
  const res = await request(app).delete(`/roles/${builtInId}`);
  assert.equal(res.status, 400);
});
