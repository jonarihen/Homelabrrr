// PATCH /api/admin/users/:id applies a staged batch of user edits (#202).
// Run with:  node --test src/routes/adminUserPatch.test.ts   (from backend/)
//
// The batch is all-or-nothing: any invalid field rejects before a write, and
// a DB failure partway rolls back everything. Each sub-change keeps its own
// permission gate, and a stale `version` answers 409.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, roles, vlans, userVlans, vmAssignments, auditLog } from '../db/schema/index.ts';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let adminApp: express.Express;
let delegateApp: express.Express;
let targetId: number;
let otherId: number;
let adminTargetId: number;
let roleId: number;
let vlanA: number;
let vlanB: number;

function appFor(session) {
  return async () => {
    const adminRouter = (await import('./admin.ts')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { ...session, reauthenticatedAt: Date.now() } as never;
      next();
    });
    app.use('/', adminRouter);
    return app;
  };
}

async function readUser(id: number) {
  const [row] = await testDb.db.select().from(users).where(eq(users.id, id));
  const vms = await testDb.db.select().from(vmAssignments).where(eq(vmAssignments.user_id, id));
  const vl = await testDb.db.select().from(userVlans).where(eq(userVlans.user_id, id));
  return { row, vms, vlans: vl.map((v) => v.vlan_id).sort() };
}

async function version(app, id) {
  const res = await request(app).get(`/users/${id}/state`);
  assert.equal(res.status, 200);
  return res.body.version;
}

async function roleVersion(app, id, roleId) {
  const res = await request(app).get(`/users/${id}/state`);
  assert.equal(res.status, 200);
  return res.body.roleDefinitions.find((r) => r.id === roleId)?.version;
}

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [admin] = await testDb.db.insert(users)
    .values({ username: 'patch-admin', password: 'x', is_admin: true }).returning({ id: users.id });
  const [delegate] = await testDb.db.insert(users)
    .values({ username: 'patch-delegate', password: 'x', can_manage_assignments: true }).returning({ id: users.id });
  [{ id: targetId }, { id: otherId }, { id: adminTargetId }] = await testDb.db.insert(users).values([
    { username: 'target', password: 'x' },
    { username: 'other', password: 'x' },
    { username: 'admin2', password: 'x', is_admin: true },
  ]).returning({ id: users.id });
  [{ id: roleId }] = await testDb.db.insert(roles).values({ name: 'PatchRole' }).returning({ id: roles.id });
  [{ id: vlanA }, { id: vlanB }] = await testDb.db.insert(vlans).values([
    { name: 'lab-a', tag: 3101 },
    { name: 'lab-b', tag: 3102 },
  ]).returning({ id: vlans.id });
  await testDb.db.insert(vmAssignments).values({ user_id: otherId, node: '1~pve', vmid: 900 });

  adminApp = await appFor({ userId: admin.id, username: 'patch-admin', isAdmin: true })();
  delegateApp = await appFor({ userId: delegate.id, username: 'patch-delegate', isAdmin: false })();
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('state exposes a version that changes when the user changes', async () => {
  const v1 = await version(adminApp, targetId);
  await testDb.db.update(users).set({ can_manage_hosts: true }).where(eq(users.id, targetId));
  const v2 = await version(adminApp, targetId);
  assert.notEqual(v1, v2);
  await testDb.db.update(users).set({ can_manage_hosts: false }).where(eq(users.id, targetId));
  assert.equal(await version(adminApp, targetId), v1);
});

test('a full batch applies every change and audits each one', async () => {
  const v = await version(adminApp, targetId);
  const res = await request(adminApp).patch(`/users/${targetId}`).send({
    version: v,
    roleId, roleVersion: await roleVersion(adminApp, targetId, roleId),
    permissions: { can_operate_all_vms: true, see_all_vms: true },
    require2fa: true,
    quotas: { maxCores: 4, maxMemoryGb: '', maxStorageGb: 50 },
    vms: { add: [{ node: '1~pve', vmid: 101 }, { node: '1~pve', vmid: 102 }] },
    vlans: { add: [vlanA, vlanB] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, 9);
  assert.notEqual(res.body.version, v);

  const { row, vms, vlans: vl } = await readUser(targetId);
  assert.equal(row.role_id, roleId);
  assert.equal(row.can_operate_all_vms, true);
  assert.equal(row.see_all_vms, true);
  assert.equal(row.require_2fa, true);
  assert.equal(row.max_cores, 4);
  assert.equal(row.max_memory_gb, null);
  assert.equal(row.max_storage_gb, 50);
  assert.deepEqual(vms.map((x) => x.vmid).sort(), [101, 102]);
  assert.deepEqual(vl, [vlanA, vlanB].sort());

  const audits = await testDb.db.select().from(auditLog);
  const actions = audits.map((a) => a.action).sort();
  assert.deepEqual(actions, [
    'admin_assign_role', 'admin_assign_vlan', 'admin_assign_vlan', 'admin_assign_vm', 'admin_assign_vm',
    'admin_set_quotas', 'admin_toggle_permission', 'admin_toggle_permission', 'admin_toggle_permission',
  ]);
});

test('a stale version answers 409 and changes nothing', async () => {
  const before = await readUser(targetId);
  const res = await request(adminApp).patch(`/users/${targetId}`)
    .send({ version: 'stale', permissions: { can_manage_hosts: true } });
  assert.equal(res.status, 409);
  const afterState = await readUser(targetId);
  assert.equal(afterState.row.can_manage_hosts, before.row.can_manage_hosts);
});

test('any invalid field rejects the whole batch before writing', async () => {
  const before = await readUser(targetId);
  const cases = [
    { permissions: { can_manage_hosts: true, not_a_perm: true } },
    { permissions: { can_manage_hosts: 'yes' } },
    { permissions: { can_manage_hosts: true }, quotas: { maxCores: -1 } },
    { permissions: { can_manage_hosts: true }, vms: { add: [{ node: '', vmid: 5 }] } },
    { permissions: { can_manage_hosts: true }, vlans: { add: [vlanA], remove: [vlanA] } },
    { permissions: { can_manage_hosts: true }, roleId: 'abc' },
    { permissions: { can_manage_hosts: true }, surprise: 1 },
  ];
  for (const body of cases) {
    const res = await request(adminApp).patch(`/users/${targetId}`).send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  const afterState = await readUser(targetId);
  assert.equal(afterState.row.can_manage_hosts, before.row.can_manage_hosts);
});

test('a DB conflict partway through rolls back the earlier writes', async () => {
  const before = await readUser(targetId);
  const res = await request(adminApp).patch(`/users/${targetId}`).send({
    permissions: { can_manage_hosts: true },
    roleId: null,
    vms: { add: [{ node: '1~pve', vmid: 103 }, { node: '1~pve', vmid: 900 }] },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already assigned/);
  const afterState = await readUser(targetId);
  assert.equal(afterState.row.can_manage_hosts, before.row.can_manage_hosts, 'permission write rolled back');
  assert.equal(afterState.row.role_id, before.row.role_id, 'role write rolled back');
  assert.deepEqual(afterState.vms.map((x) => x.vmid).sort(), before.vms.map((x) => x.vmid).sort(), 'first VM insert rolled back');
});

test('removing an assignment that is not the user\'s answers 409 and rolls back', async () => {
  const [foreign] = await testDb.db.select().from(vmAssignments).where(eq(vmAssignments.user_id, otherId));
  const before = await readUser(targetId);
  const res = await request(adminApp).patch(`/users/${targetId}`).send({
    vlans: { remove: [vlanA] },
    vms: { remove: [foreign.id] },
  });
  assert.equal(res.status, 409);
  const afterState = await readUser(targetId);
  assert.deepEqual(afterState.vlans, before.vlans);
  const [still] = await testDb.db.select().from(vmAssignments).where(eq(vmAssignments.id, foreign.id));
  assert.ok(still, 'another user\'s assignment is never removed');
});

test('removals apply and unknown VLAN adds are rejected', async () => {
  const { vms } = await readUser(targetId);
  const res = await request(adminApp).patch(`/users/${targetId}`).send({
    vms: { remove: [vms[0].id] },
    vlans: { remove: [vlanB] },
  });
  assert.equal(res.status, 200);
  const afterState = await readUser(targetId);
  assert.equal(afterState.vms.length, 1);
  assert.deepEqual(afterState.vlans, [vlanA]);

  const bad = await request(adminApp).patch(`/users/${targetId}`).send({ vlans: { add: [999999] } });
  assert.equal(bad.status, 400);
});

test('a delegated assignments manager may stage VM/VLAN changes only', async () => {
  const ok = await request(delegateApp).patch(`/users/${targetId}`).send({ vlans: { add: [vlanB] } });
  assert.equal(ok.status, 200);

  const before = await readUser(targetId);
  for (const body of [
    { permissions: { can_manage_users: true } },
    { roleId: null },
    { require2fa: false },
    { quotas: { maxCores: 99 } },
    { vlans: { remove: [vlanB] }, permissions: { can_manage_users: true } },
  ]) {
    const res = await request(delegateApp).patch(`/users/${targetId}`).send(body);
    assert.equal(res.status, 403, `expected 403 for ${JSON.stringify(body)}`);
  }
  const afterState = await readUser(targetId);
  assert.deepEqual(afterState.vlans, before.vlans, 'a rejected mixed batch writes nothing');
  assert.equal(afterState.row.can_manage_users, false);
});

test('a delegate cannot modify an admin account', async () => {
  const res = await request(delegateApp).patch(`/users/${adminTargetId}`).send({ vlans: { add: [vlanA] } });
  assert.equal(res.status, 403);
});

test('unknown and malformed user ids answer 404', async () => {
  assert.equal((await request(adminApp).patch('/users/999999').send({})).status, 404);
  assert.equal((await request(adminApp).patch('/users/abc').send({})).status, 404);
  assert.equal((await request(adminApp).get('/users/abc/state')).status, 404);
});

test('audit rows commit with the batch and roll back with it', async () => {
  const countAudits = async () => (await testDb.db.select().from(auditLog)).length;
  const beforeCount = await countAudits();
  const failed = await request(adminApp).patch(`/users/${targetId}`).send({
    permissions: { can_manage_templates: true },
    vms: { add: [{ node: '1~pve', vmid: 900 }] },
  });
  assert.equal(failed.status, 400);
  assert.equal(await countAudits(), beforeCount, 'a rolled-back batch leaves no audit rows behind');

  const ok = await request(adminApp).patch(`/users/${targetId}`).send({ permissions: { can_manage_templates: true } });
  assert.equal(ok.status, 200);
  const rows = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'admin_toggle_permission'));
  assert.ok(rows.some((r) => r.detail === 'can_manage_templates=1' && r.username === 'patch-admin'));
});

test('role assignment audits carry stable refs for both the new and old role', async () => {
  const res = await request(adminApp).patch(`/users/${otherId}`).send({ roleId, roleVersion: await roleVersion(adminApp, otherId, roleId) });
  assert.equal(res.status, 200);
  const rows = await testDb.db.select().from(auditLog).where(eq(auditLog.target_ref, `role:${roleId}`));
  assert.ok(rows.some((r) => r.action === 'admin_assign_role' && r.target === 'other'));

  const [oldRole] = await testDb.db.insert(roles).values({ name: 'PriorRole' }).returning({ id: roles.id });
  const moved = await request(adminApp).patch(`/users/${otherId}`).send({ roleId: oldRole.id, roleVersion: await roleVersion(adminApp, otherId, oldRole.id) });
  assert.equal(moved.status, 200);
  const priorHistory = await testDb.db.select().from(auditLog).where(eq(auditLog.target_ref, `role:${roleId}`));
  assert.ok(priorHistory.some((r) => r.action === 'admin_unassign_role' && r.target === 'other'));
});

test('fractional or exponential quotas are rejected, not truncated', async () => {
  const before = await readUser(targetId);
  for (const maxCores of ['1.5', '1e2', '8abc', 1.5, '2147483648']) {
    const res = await request(adminApp).patch(`/users/${targetId}`).send({ quotas: { maxCores } });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(maxCores)}`);
  }
  assert.equal((await readUser(targetId)).row.max_cores, before.row.max_cores);
  const ok = await request(adminApp).patch(`/users/${targetId}`).send({ quotas: { maxCores: ' 12 ' } });
  assert.equal(ok.status, 200);
  assert.equal((await readUser(targetId)).row.max_cores, 12);
});

test('malformed nested sections reject the whole batch', async () => {
  const before = await readUser(targetId);
  const bad = [
    { quotas: { maxCore: 4 } },
    { quotas: 'invalid' },
    { quotas: {} },
    { vms: { adds: [{ node: '1~pve', vmid: 99 }] } },
    { vms: 'invalid' },
    { vms: { add: [{ node: '1~pve', vmid: 99, extra: true }] } },
    { vlans: { adds: [vlanA] } },
    { vlans: [] },
  ];
  for (const section of bad) {
    const res = await request(adminApp).patch(`/users/${targetId}`).send({ permissions: { can_manage_hosts: true }, ...section });
    assert.equal(res.status, 400, JSON.stringify(section));
  }
  assert.equal((await readUser(targetId)).row.can_manage_hosts, before.row.can_manage_hosts);
});

test('a renamed user rejects the stale version', async () => {
  const v = await version(adminApp, targetId);
  await testDb.db.update(users).set({ username: 'target-renamed' }).where(eq(users.id, targetId));
  const res = await request(adminApp).patch(`/users/${targetId}`).send({ version: v, permissions: { can_manage_hosts: true } });
  assert.equal(res.status, 409);
  await testDb.db.update(users).set({ username: 'target' }).where(eq(users.id, targetId));
});

test('a changed role definition rejects assignment reviewed against the old version', async () => {
  const stateRes = await request(adminApp).get(`/users/${targetId}/state`);
  const definition = stateRes.body.roleDefinitions.find((r) => r.id === roleId);
  assert.ok(definition?.version);
  const changed = await testDb.db.insert(roles).values({ name: 'VersionedRole' }).returning({ id: roles.id });
  const fresh = await request(adminApp).get(`/users/${targetId}/state`);
  const dest = fresh.body.roleDefinitions.find((r) => r.id === changed[0].id);
  const { rolePermissions } = await import('../db/schema/index.ts');
  await testDb.db.insert(rolePermissions).values({ role_id: dest.id, permission: 'can_operate_all_vms' });

  const res = await request(adminApp).patch(`/users/${targetId}`).send({ roleId: dest.id, roleVersion: dest.version });
  assert.equal(res.status, 409);
  assert.equal((await readUser(targetId)).row.role_id, roleId);
});

test('a changed current role definition makes the user state stale', async () => {
  const v = await version(adminApp, targetId);
  await testDb.db.update(roles).set({ max_cores: 99 }).where(eq(roles.id, roleId));
  const res = await request(adminApp).patch(`/users/${targetId}`).send({ version: v, permissions: { can_manage_hosts: true } });
  assert.equal(res.status, 409);
  await testDb.db.update(roles).set({ max_cores: null }).where(eq(roles.id, roleId));
});

test('an unknown role is rejected without writing', async () => {
  const before = await readUser(targetId);
  const res = await request(adminApp).patch(`/users/${targetId}`)
    .send({ roleId: 999999, roleVersion: 'a'.repeat(24), permissions: { can_manage_hosts: !before.row.can_manage_hosts } });
  assert.equal(res.status, 400);
  const afterState = await readUser(targetId);
  assert.equal(afterState.row.can_manage_hosts, before.row.can_manage_hosts);
});
