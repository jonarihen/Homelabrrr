// DB-backed coverage for the route-guard middleware: the requirePermission
// factory now awaits the async utils/permissions check, and the interactive
// session/reauthentication guards write their denial audits fire-and-forget
// (conventions M13) so the 403 payload never depends on the audit insert.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { desc, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, roles, rolePermissions, auditLog } from '../db/schema/index.ts';

// The middleware reaches the singleton db (src/db/client.ts) through
// utils/permissions.ts and utils/audit.ts, and client.ts reads DATABASE_URL
// at import time — so everything is imported dynamically after the throwaway
// database exists.
let testDb: TestDatabase;
let auth: typeof import('./auth.ts');
let closeDb: (() => Promise<void>) | undefined;

let adminUserId: number;
let roleUserId: number; // permission only via role
let columnUserId: number; // permission only via legacy per-user column
let plainUserId: number; // no permissions at all

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  ({ closeDb } = await import('../db/client.ts'));
  auth = await import('./auth.ts');

  const [{ id: roleId }] = await testDb.db
    .insert(roles)
    .values({ name: 'VLAN Operator' })
    .returning({ id: roles.id });
  await testDb.db.insert(rolePermissions).values({ role_id: roleId, permission: 'can_manage_vlans' });

  [{ id: adminUserId }] = await testDb.db
    .insert(users)
    .values({ username: 'guard-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });
  [{ id: roleUserId }] = await testDb.db
    .insert(users)
    .values({ username: 'guard-role-user', password: 'x', role_id: roleId })
    .returning({ id: users.id });
  [{ id: columnUserId }] = await testDb.db
    .insert(users)
    .values({ username: 'guard-column-user', password: 'x', can_manage_firewalls: true })
    .returning({ id: users.id });
  [{ id: plainUserId }] = await testDb.db
    .insert(users)
    .values({ username: 'guard-plain-user', password: 'x' })
    .returning({ id: users.id });
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

/** Minimal req/res/next harness — enough surface for these guards. */
function run(middleware: (req: any, res: any, next: any) => unknown, req: Record<string, unknown>) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  let nextCalled = false;
  const result = middleware(req, res, () => { nextCalled = true; });
  return { res, result, get nextCalled() { return nextCalled; } };
}

/** The denial audits are fire-and-forget — poll until the row lands. */
async function waitForAuditRow(action: string, target: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, action))
      .orderBy(desc(auditLog.id))
      .limit(1);
    if (row?.target === target) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`audit row ${action} for ${target} was not written`);
}

test('requireAuth rejects anonymous requests and passes sessions through', () => {
  const denied = run(auth.requireAuth, { session: {} });
  assert.equal(denied.res.statusCode, 401);
  assert.equal(denied.nextCalled, false);

  const allowed = run(auth.requireAuth, { session: { userId: plainUserId } });
  assert.equal(allowed.nextCalled, true);
});

test('requireAdmin distinguishes anonymous, non-admin, and admin sessions', () => {
  assert.equal(run(auth.requireAdmin, {}).res.statusCode, 401);

  const nonAdmin = run(auth.requireAdmin, { session: { userId: plainUserId, isAdmin: false } });
  assert.equal(nonAdmin.res.statusCode, 403);
  assert.equal(nonAdmin.nextCalled, false);

  assert.equal(run(auth.requireAdmin, { session: { userId: adminUserId, isAdmin: true } }).nextCalled, true);
});

test('requirePermission grants via admin bypass, role, or legacy column and denies otherwise', async () => {
  const guard = auth.requirePermission('can_manage_vlans', 'can_manage_firewalls');

  const anonymous = run(guard, { session: {} });
  await anonymous.result;
  assert.equal(anonymous.res.statusCode, 401);

  // Admin bypass happens before any DB work: session flag alone decides.
  const admin = run(guard, { session: { userId: adminUserId, isAdmin: true } });
  await admin.result;
  assert.equal(admin.nextCalled, true);

  const viaRole = run(guard, { session: { userId: roleUserId } });
  await viaRole.result;
  assert.equal(viaRole.nextCalled, true);

  // Any-of semantics: the column user holds the second key only.
  const viaColumn = run(guard, { session: { userId: columnUserId } });
  await viaColumn.result;
  assert.equal(viaColumn.nextCalled, true);

  const denied = run(guard, { session: { userId: plainUserId } });
  await denied.result;
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.nextCalled, false);
});

test('requireInteractiveSession blocks API tokens with an audited 403', async () => {
  const denied = run(auth.requireInteractiveSession, {
    apiToken: { id: 1, name: 'ci-token' },
    session: { userId: plainUserId, username: 'guard-plain-user' },
    originalUrl: '/api/auth/tokens?probe=1',
  });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.nextCalled, false);
  const row = await waitForAuditRow('api_token_interactive_operation_denied', '/api/auth/tokens');
  assert.equal(row.detail, 'interactive session required');
  assert.match(row.username, /token: ci-token/);

  assert.equal(run(auth.requireInteractiveSession, { session: { userId: plainUserId } }).nextCalled, true);
});

test('requireRecentReauthentication enforces the 15-minute window', async () => {
  const stale = run(auth.requireRecentReauthentication, {
    session: { userId: plainUserId, reauthenticatedAt: Date.now() - 16 * 60 * 1000 },
    originalUrl: '/api/auth/password',
  });
  assert.equal(stale.res.statusCode, 403);
  assert.equal((stale.res.body as { code?: string }).code, 'REAUTHENTICATION_REQUIRED');
  await waitForAuditRow('recent_reauthentication_required', '/api/auth/password');

  const missing = run(auth.requireRecentReauthentication, { session: { userId: plainUserId }, originalUrl: '/x' });
  assert.equal(missing.res.statusCode, 403);

  const fresh = run(auth.requireRecentReauthentication, {
    session: { userId: plainUserId, reauthenticatedAt: Date.now() - 60 * 1000 },
  });
  assert.equal(fresh.nextCalled, true);

  const token = run(auth.requireRecentReauthentication, {
    apiToken: { id: 1, name: 'ci-token' },
    session: { userId: plainUserId },
    originalUrl: '/api/auth/password',
  });
  assert.equal(token.res.statusCode, 403);
});
