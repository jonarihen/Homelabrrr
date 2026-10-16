// A can_manage_users delegate may only manage users whose effective
// permissions are a subset of its own, including their API tokens
// (GHSA-7hxh-c42g-8cvq).
// Run with:  node --test src/routes/adminDelegateGuard.test.ts   (from backend/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, roles, rolePermissions, apiTokens } from '../db/schema/index.ts';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let delegateApp: express.Express;
let adminApp: express.Express;
let plainId: number;
let strongerId: number;
let roleStrongerId: number;
let adminId: number;
let plainTokenId: number;
let adminTokenId: number;
let operatorApp: express.Express;
let seerApp: express.Express;
let seeTargetId: number;
let operateTargetId: number;

async function appFor(session) {
  const adminRouter = (await import('./admin.ts')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { ...session, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', adminRouter);
  return app;
}

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [{ id: roleId }] = await testDb.db.insert(roles).values({ name: 'HostsRole' }).returning({ id: roles.id });
  await testDb.db.insert(rolePermissions).values({ role_id: roleId, permission: 'can_manage_hosts' });
  const [delegate] = await testDb.db.insert(users)
    .values({ username: 'guard-delegate', password: 'x', can_manage_users: true }).returning({ id: users.id });
  [{ id: plainId }, { id: strongerId }, { id: roleStrongerId }, { id: adminId }] = await testDb.db.insert(users).values([
    { username: 'plain', password: 'x' },
    { username: 'stronger', password: 'x', can_manage_users: true, see_all_vms: true },
    { username: 'role-stronger', password: 'x', role_id: roleId },
    { username: 'guard-admin', password: 'x', is_admin: true },
  ]).returning({ id: users.id });
  [{ id: plainTokenId }, { id: adminTokenId }] = await testDb.db.insert(apiTokens).values([
    { user_id: plainId, name: 'plain-token', token_hash: 'h1' },
    { user_id: adminId, name: 'admin-token', token_hash: 'h2' },
  ]).returning({ id: apiTokens.id });

  const [operator, seer] = await testDb.db.insert(users).values([
    { username: 'operator-delegate', password: 'x', can_manage_users: true, can_operate_all_vms: true },
    { username: 'seer-delegate', password: 'x', can_manage_users: true, see_all_vms: true },
  ]).returning({ id: users.id });
  [{ id: seeTargetId }, { id: operateTargetId }] = await testDb.db.insert(users).values([
    { username: 'see-target', password: 'x', see_all_vms: true },
    { username: 'operate-target', password: 'x', can_operate_all_vms: true },
  ]).returning({ id: users.id });
  operatorApp = await appFor({ userId: operator.id, isAdmin: false });
  seerApp = await appFor({ userId: seer.id, isAdmin: false });
  delegateApp = await appFor({ userId: delegate.id, isAdmin: false });
  adminApp = await appFor({ userId: adminId, isAdmin: true });
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('delegate cannot reset the password of a user with permissions it lacks', async () => {
  for (const id of [strongerId, roleStrongerId, adminId]) {
    const res = await request(delegateApp).put(`/users/${id}/password`).send({ password: 'N3w-passw0rd-long!' });
    assert.equal(res.status, 403, `target ${id}`);
  }
  const [row] = await testDb.db.select({ password: users.password }).from(users).where(eq(users.id, strongerId));
  assert.equal(row.password, 'x');
});

test('delegate can still manage a user whose permissions are a subset of its own', async () => {
  const res = await request(delegateApp).put(`/users/${plainId}/password`).send({ password: 'N3w-passw0rd-long!' });
  assert.equal(res.status, 200);
});

test('admin bypasses the guard', async () => {
  const res = await request(adminApp).put(`/users/${strongerId}/password`).send({ password: 'N3w-passw0rd-long!' });
  assert.equal(res.status, 200);
});

test('token listing is guarded by the target user', async () => {
  assert.equal((await request(delegateApp).get(`/users/${adminId}/tokens`)).status, 403);
  assert.equal((await request(delegateApp).get(`/users/${strongerId}/tokens`)).status, 403);
  const ok = await request(delegateApp).get(`/users/${plainId}/tokens`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.map((t) => t.name), ['plain-token']);
});

test('token revocation is guarded by the token owner', async () => {
  assert.equal((await request(delegateApp).delete(`/tokens/${adminTokenId}`)).status, 403);
  assert.equal((await testDb.db.select().from(apiTokens).where(eq(apiTokens.id, adminTokenId))).length, 1);
  assert.equal((await request(delegateApp).delete(`/tokens/${plainTokenId}`)).status, 200);
  assert.equal((await testDb.db.select().from(apiTokens).where(eq(apiTokens.id, plainTokenId))).length, 0);
});

test('implied permissions count for the caller, in one direction only', async () => {
  // can_operate_all_vms implies see_all_vms.
  assert.equal((await request(operatorApp).post(`/users/${seeTargetId}/unlock`)).status, 200);
  assert.equal((await request(seerApp).post(`/users/${operateTargetId}/unlock`)).status, 403);
});
