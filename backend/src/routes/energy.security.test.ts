import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import signature from 'cookie-signature';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { apiTokens, auditLog, paypalWebhookInbox, settings, users } from '../db/schema/index.ts';

// Energy & Budget routes on the REAL middleware stack, assembled in the same
// order as src/index.ts. No provider is ever contacted: any fetch fails the test.
process.env.SECRET_ENCRYPTION_KEY = '78'.repeat(32);
process.env.ALLOWED_ORIGIN = 'https://portal.example';
const SECRET = 'energy-security-session-secret';
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());

const fetchCalls: string[] = [];
globalThis.fetch = (async (url: string | URL | Request) => { fetchCalls.push(String(url)); throw new Error('no upstream calls allowed'); }) as typeof fetch;

const { default: energyRoutes } = await import('./energy.ts');
const { default: paymentsRoutes } = await import('./payments.ts');
const { default: webhookRoutes } = await import('./paymentsWebhook.ts');
const { DrizzleSessionStore } = await import('../db/sessionStore.ts');
const { authenticateApiToken, enforceApiTokenScope } = await import('../middleware/apiToken.ts');
const { csrfProtection } = await import('../middleware/requestSecurity.ts');
const { enforceTwoFactorEnrollmentOnly } = await import('../middleware/twoFactorEnrollment.ts');
const { requestContext } = await import('../utils/logger.ts');
const { generateApiToken, hashApiToken } = await import('../utils/apiTokens.ts');
const { db, closeDb } = await import('../db/client.ts');
test.after(() => closeDb());

const store = new DrizzleSessionStore();
const app = express();
app.set('trust proxy', 1);
app.use(requestContext);
app.use('/api/payments/paypal/webhook', webhookRoutes);
app.use(express.json({ limit: '1mb' }));
const sessionMiddleware = session({ store, secret: SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 24 * 60 * 60 * 1000 } });
app.use((req, res, next) => (/^Bearer\s+/i.test(req.headers.authorization || '') ? authenticateApiToken(req, res, next) : sessionMiddleware(req, res, next)));
app.use(enforceApiTokenScope);
app.use(csrfProtection({ allowedOrigin: process.env.ALLOWED_ORIGIN }));
// Mirrors the live-user hydration in src/index.ts (deleted users lose their session).
app.use(async (req, _res, next) => {
  if (!req.session?.userId || req.apiToken) return next();
  const [user] = await db.select({ username: users.username, is_admin: users.is_admin }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!user) return req.session.destroy(() => next());
  req.session.username = user.username; req.session.isAdmin = user.is_admin === true;
  next();
});
app.use(enforceTwoFactorEnrollmentOnly);
app.use('/api/payments', paymentsRoutes);
app.use('/api/energy', energyRoutes);

async function login(sid: string, data: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => store.set(sid, { cookie: { originalMaxAge: 86_400_000, expires: new Date(Date.now() + 86_400_000) },
    ...data } as any, (err?: unknown) => (err ? reject(err) : resolve())));
  return `connect.sid=${encodeURIComponent(`s:${signature.sign(sid, SECRET)}`)}`;
}
const ORIGIN = { Origin: 'https://portal.example' };
const MEMBER_READS = ['/api/energy/summary', '/api/energy/summary.csv', '/api/energy/history?range=7d', '/api/energy/months', '/api/energy/hosts', '/api/energy/preview'];
const ADMIN_READS = ['/api/energy/admin/overview', '/api/energy/admin/export.csv'];
let member = ''; let admin = ''; let staleAdmin = ''; let enrollment = ''; let deleted = ''; let revoked = '';

test.before(async () => {
  await fixture.db.insert(users).values([
    { id: 1, username: 'member-energy', password: 'unused' }, { id: 2, username: 'admin-energy', password: 'unused', is_admin: true },
    { id: 3, username: 'enrolling-energy', password: 'unused' }, { id: 4, username: 'deleted-energy', password: 'unused' },
  ]);
  member = await login('sid-member', { userId: 1 });
  admin = await login('sid-admin', { userId: 2, reauthenticatedAt: Date.now() });
  staleAdmin = await login('sid-stale-admin', { userId: 2 });
  enrollment = await login('sid-enrolling', { userId: 3, twoFactorEnrollmentOnly: true });
  deleted = await login('sid-deleted', { userId: 4 });
  revoked = await login('sid-revoked', { userId: 1 });
});

test('anonymous, 2FA-enrollment-only, deleted and revoked sessions cannot read energy pages, APIs or exports', async () => {
  for (const path of [...MEMBER_READS, ...ADMIN_READS]) {
    assert.equal((await request(app).get(path)).status, 401, `anonymous ${path}`);
    assert.equal((await request(app).get(path).set('Cookie', enrollment)).status, 403, `enrollment-only ${path}`);
  }
  await fixture.db.delete(users).where(eq(users.id, 4));
  assert.equal((await request(app).get('/api/energy/summary').set('Cookie', deleted)).status, 401, 'a deleted member loses access');
  await new Promise<void>((resolve) => store.destroy('sid-revoked', () => resolve()));
  assert.equal((await request(app).get('/api/energy/summary').set('Cookie', revoked)).status, 401, 'a revoked session loses access');
});

test('API tokens, even admin-scoped, cannot read energy or budget data', async () => {
  for (const [userId, scopes] of [[1, 'read'], [2, 'admin']] as const) {
    const token = generateApiToken();
    await fixture.db.insert(apiTokens).values({ user_id: userId, name: `energy-${userId}`, token_hash: hashApiToken(token), scopes });
    for (const path of [...MEMBER_READS, ...ADMIN_READS])
      assert.equal((await request(app).get(path).set({ Authorization: `Bearer ${token}` })).status, 403, `${scopes} token ${path}`);
  }
});

test('members read private aggregates with no-store; admin view, export and sharing stay admin-only', async () => {
  for (const path of MEMBER_READS) {
    const response = await request(app).get(path).set('Cookie', member);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
    assert.match(response.headers['cache-control'], /private, no-store/, path);
  }
  const exported = await request(app).get('/api/energy/summary.csv?month=2026-09').set('Cookie', member);
  assert.match(exported.headers['content-type'], /text\/csv/);
  assert.match(exported.headers['content-disposition'], /attachment; filename="energy-budget-2026-09.csv"/);
  assert.match(exported.text, /^field,value\r\nmonth,2026-09\r\n/);
  for (const path of ADMIN_READS) assert.equal((await request(app).get(path).set('Cookie', member)).status, 403, `member ${path}`);
  assert.equal((await request(app).put('/api/energy/admin/household-share').set('Cookie', member).set(ORIGIN).send({ mode: 'paid' })).status, 403);
  // Bounded inputs.
  assert.equal((await request(app).get('/api/energy/summary?month=2999-01').set('Cookie', member)).status, 400);
  assert.equal((await request(app).get('/api/energy/months?count=500').set('Cookie', member)).status, 400);
  assert.equal((await request(app).get('/api/energy/history?range=1y').set('Cookie', member)).status, 400);
  for (const path of ['/api/payments/status', '/api/payments/mine']) {
    const response = await request(app).get(path).set('Cookie', member);
    assert.equal(response.status, 200, path);
    assert.match(response.headers['cache-control'], /private, no-store/, path);
  }
  assert.deepEqual(fetchCalls, [], 'page reads never call an upstream service');
});

test('household sharing requires admin, same origin and recent reauthentication, and is audited', async () => {
  assert.equal((await request(app).put('/api/energy/admin/household-share').set('Cookie', admin).send({ mode: 'paid' })).status, 403, 'CSRF origin check');
  const stale = await request(app).put('/api/energy/admin/household-share').set('Cookie', staleAdmin).set(ORIGIN).send({ mode: 'paid' });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'REAUTHENTICATION_REQUIRED');
  assert.equal((await request(app).put('/api/energy/admin/household-share').set('Cookie', admin).set(ORIGIN).send({ mode: 'everything' })).status, 400);
  assert.equal((await fixture.db.select().from(settings).where(eq(settings.key, 'energy_household_total_share'))).length, 0, 'default stays off');
  const saved = await request(app).put('/api/energy/admin/household-share').set('Cookie', admin).set(ORIGIN).send({ mode: 'invoiced' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { householdShare: 'invoiced' });
  assert.equal((await request(app).get('/api/energy/admin/overview').set('Cookie', admin)).body.householdShare, 'invoiced');
  const audits = await fixture.db.select().from(auditLog).where(eq(auditLog.action, 'energy.household_share.set'));
  assert.equal(audits.length, 1);
  await request(app).put('/api/energy/admin/household-share').set('Cookie', admin).set(ORIGIN).send({ mode: 'off' });
});

test('admin export requires recent reauthentication and is formula-safe CSV', async () => {
  const stale = await request(app).get('/api/energy/admin/export.csv').set('Cookie', staleAdmin);
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'REAUTHENTICATION_REQUIRED');
  const response = await request(app).get('/api/energy/admin/export.csv?from=2026-01&to=2026-09').set('Cookie', admin);
  assert.equal(response.status, 200);
  assert.match(response.headers['cache-control'], /no-store/);
  assert.match(response.text, /^record_type,month,record_id/);
  assert.equal((await request(app).get('/api/energy/admin/export.csv?from=2026-09&to=2026-01').set('Cookie', admin)).status, 400);
});

test('the PayPal callback is reachable without a browser login while every neighbour still requires authorization', async () => {
  const event = { id: 'WH-ENERGY', event_type: 'CHECKOUT.ORDER.APPROVED', create_time: '2026-10-08T12:01:00Z', resource: { id: 'ORDER' } };
  const callback = await request(app).post('/api/payments/paypal/webhook/live').set({ 'x-forwarded-proto': 'https', 'content-type': 'application/json',
    'paypal-transmission-id': 'T', 'paypal-transmission-time': '2026-10-08T12:01:00Z', 'paypal-cert-url': 'https://api-m.paypal.com/v1/notifications/certs/C',
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': 'sig' }).send(JSON.stringify(event));
  assert.notEqual(callback.status, 401, 'no session is required to reach the callback handler');
  assert.notEqual(callback.status, 403, 'no browser origin is required for the callback');
  assert.equal((await fixture.db.select().from(paypalWebhookInbox)).length, 0, 'an unverified callback stores nothing');
  for (const path of ['/api/payments/status', '/api/payments/mine', '/api/payments/admin/summary', '/api/payments/admin/export.csv',
    '/api/energy/summary', '/api/energy/admin/overview'])
    assert.equal((await request(app).get(path)).status, 401, path);
  assert.equal((await request(app).post('/api/payments/one-off').set(ORIGIN).send({ amount: '100.00' })).status, 401);
  assert.equal((await request(app).post('/api/payments/paypal/webhook-other/live').send('{}')).status, 403, 'a near-miss path is not exempt');
});
