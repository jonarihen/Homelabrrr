import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { apiTokens, tokenAuthAttempts, users } from '../db/schema/index.ts';
import { eq } from 'drizzle-orm';
import { generateApiToken, hashApiToken } from '../utils/apiTokens.ts';
import { requiredScopeForRequest } from '../utils/apiTokenScopes.ts';

// apiToken.ts queries through the singleton db (src/db/client.ts), which reads
// DATABASE_URL at import time — so the module is imported dynamically after
// the throwaway database exists.
let testDb: TestDatabase;
let middleware: typeof import('./apiToken.ts');
let closeDb: (() => Promise<void>) | undefined;
let userId: number;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  ({ closeDb } = await import('../db/client.ts'));
  middleware = await import('./apiToken.ts');
  const [row] = await testDb.db
    .insert(users)
    .values({ username: 'token-owner', password: 'irrelevant-hash', is_admin: true })
    .returning({ id: users.id });
  userId = row.id;
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

async function createToken(overrides: Partial<typeof apiTokens.$inferInsert> = {}) {
  const raw = generateApiToken();
  const [row] = await testDb.db
    .insert(apiTokens)
    .values({ user_id: userId, name: 'test-token', token_hash: hashApiToken(raw), ...overrides })
    .returning({ id: apiTokens.id });
  return { raw, id: row.id };
}

function fakeReq(authorization: string | undefined, ip: string) {
  return { headers: { authorization }, ip, socket: {}, path: '/api/vms', originalUrl: '/api/vms' };
}

function fakeRes() {
  const res: any = { statusCode: null, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: any) => { res.body = payload; return res; };
  return res;
}

async function run(req: any) {
  const res = fakeRes();
  let nextCalled = false;
  await middleware.authenticateApiToken(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function failureRows(ip: string) {
  return testDb.db.select().from(tokenAuthAttempts).where(eq(tokenAuthAttempts.ip, ip));
}

test('a valid non-expiring token authenticates and resolves the live user', async () => {
  const { raw, id } = await createToken({ scopes: 'read,vm:operate' });
  const req: any = fakeReq(`Bearer ${raw}`, '203.0.113.10');
  const { res, nextCalled } = await run(req);

  assert.equal(nextCalled, true, JSON.stringify(res.body));
  assert.equal(res.statusCode, null);
  assert.deepEqual(
    { userId: req.session.userId, username: req.session.username, isAdmin: req.session.isAdmin },
    { userId, username: 'token-owner', isAdmin: true }
  );
  // isAdmin must be a real boolean (downstream checks and JSON responses rely on it).
  assert.equal(typeof req.session.isAdmin, 'boolean');
  // The no-op destroy accepts a callback without touching any session store.
  let destroyed = false;
  req.session.destroy(() => { destroyed = true; });
  assert.equal(destroyed, true);
  assert.equal(req.apiToken.id, id);
  assert.equal(req.apiToken.name, 'test-token');
  assert.deepEqual([...req.apiToken.scopes].sort(), ['read', 'vm:operate']);

  // last_used_at is written fire-and-forget — poll briefly rather than racing it.
  for (let i = 0; i < 50; i++) {
    const [row] = await testDb.db.select().from(apiTokens).where(eq(apiTokens.id, id));
    if (row.last_used_at instanceof Date) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('last_used_at was never stamped');
});

test('a future-dated expiry still authenticates; an expired token is rejected and recorded', async () => {
  const ip = '203.0.113.11';
  const future = await createToken({ expires_at: new Date(Date.now() + 60 * 60 * 1000) });
  assert.equal((await run(fakeReq(`Bearer ${future.raw}`, ip))).nextCalled, true);

  const expired = await createToken({ expires_at: new Date(Date.now() - 1000) });
  const { res, nextCalled } = await run(fakeReq(`Bearer ${expired.raw}`, ip));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Invalid or expired API token');
  assert.equal((await failureRows(ip)).length, 1);
});

test('unknown and empty bearer tokens are rejected and recorded as failures', async () => {
  const ip = '203.0.113.12';
  const unknown = await run(fakeReq(`Bearer ${generateApiToken()}`, ip));
  assert.equal(unknown.res.statusCode, 401);
  assert.equal(unknown.res.body.error, 'Invalid or expired API token');

  const empty = await run(fakeReq('Bearer    ', ip));
  assert.equal(empty.res.statusCode, 401);
  assert.equal(empty.res.body.error, 'Invalid API token');

  assert.equal((await failureRows(ip)).length, 2);
});

test('too many recent failures lock the IP out, even for a valid token', async () => {
  const ip = '203.0.113.13';
  const now = Date.now();
  await testDb.db.insert(tokenAuthAttempts).values(
    Array.from({ length: 20 }, (_, i) => ({ ip, attempted_at: now - i * 1000 }))
  );
  const { raw } = await createToken();
  const { res, nextCalled } = await run(fakeReq(`Bearer ${raw}`, ip));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);

  // The same valid token still works from an IP with no failure history.
  assert.equal((await run(fakeReq(`Bearer ${raw}`, '203.0.113.14'))).nextCalled, true);
});

test('failures older than the lockout window do not count and are pruned on record', async () => {
  const ip = '203.0.113.15';
  const stale = Date.now() - 11 * 60 * 1000; // outside the 10-minute window
  await testDb.db.insert(tokenAuthAttempts).values(
    Array.from({ length: 25 }, () => ({ ip, attempted_at: stale }))
  );

  // Not locked out: the 25 stale rows are outside the window. The failed
  // attempt is recorded and the R8 transaction prunes the stale rows.
  const { res } = await run(fakeReq(`Bearer ${generateApiToken()}`, ip));
  assert.equal(res.statusCode, 401);
  const rows = await failureRows(ip);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].attempted_at > stale);
});

test('enforceApiTokenScope passes cookie sessions through untouched', () => {
  const res = fakeRes();
  let nextCalled = false;
  middleware.enforceApiTokenScope({ apiToken: undefined }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('enforceApiTokenScope blocks identity operations and missing scopes, admin scope passes', () => {
  const base = { method: 'POST', path: '/api/vms/100/start', originalUrl: '/api/vms/100/start?x=1' };

  // Identity operations (scope resolves to null) are interactive-only.
  const identity = fakeRes();
  middleware.enforceApiTokenScope(
    { ...base, path: '/api/auth/tokens', originalUrl: '/api/auth/tokens', apiToken: { name: 't', scopes: new Set(['admin']) } },
    identity, () => assert.fail('next must not run')
  );
  assert.equal(identity.statusCode, 403);

  // Missing scope → 403 with the machine-read code.
  const denied = fakeRes();
  middleware.enforceApiTokenScope({ ...base, apiToken: { name: 't', scopes: new Set(['read']) } }, denied, () => assert.fail('next must not run'));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'API_TOKEN_SCOPE_REQUIRED');

  // The admin scope satisfies any non-identity requirement.
  const admin = fakeRes();
  let nextCalled = false;
  middleware.enforceApiTokenScope({ ...base, apiToken: { name: 't', scopes: new Set(['admin']) } }, admin, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('API token scopes distinguish reads, VM writes, infrastructure, and admin writes', () => {
  assert.equal(requiredScopeForRequest({ method: 'GET', path: '/api/admin/users' }), 'read');
  assert.equal(requiredScopeForRequest({ method: 'POST', path: '/api/vms/x' }), 'vm:operate');
  assert.equal(requiredScopeForRequest({ method: 'POST', path: '/api/websites/sites' }), 'infrastructure:write');
  assert.equal(requiredScopeForRequest({ method: 'DELETE', path: '/api/public-ips/assignments/1' }), 'infrastructure:write');
  assert.equal(requiredScopeForRequest({ method: 'DELETE', path: '/api/admin/users/1' }), 'admin');
  assert.equal(requiredScopeForRequest({ method: 'POST', path: '/api/auth/tokens' }), null);
});
