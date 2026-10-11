import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import signature from 'cookie-signature';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { apiTokens, paypalIntents, paypalPostings, paypalSubscriptions, paypalWebhookInbox, users } from '../db/schema/index.ts';

// Security coverage on the REAL middleware stack, assembled in the same order
// as src/index.ts: raw webhook ingress first, then JSON, cookie session or
// Bearer token, token scope, CSRF origin check, live-user hydration, the
// 2FA-enrollment lock and finally the payments router. Only the PayPal HTTP
// transport is a fixture; nothing reaches PayPal.
process.env.SECRET_ENCRYPTION_KEY = '77'.repeat(32);
process.env.ALLOWED_ORIGIN = 'https://portal.example';
process.env.PAYPAL_WEBHOOK_RATE_LIMIT_PER_MINUTE = '40';
const SECRET = 'payments-security-session-secret';
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());

const calls: Array<{ method: string; path: string }> = [];
let verifyMode: 'success' | 'failure' | 'outage' = 'success';
let orderState: { status: string; amount: string; currency: string; customId: string | null; merchant: string; captures?: any[]; refunds?: any[] } =
  { status: 'APPROVED', amount: '100.00', currency: 'DKK', customId: null, merchant: 'MERCHANT123' };
let subscriptionStatus = 'ACTIVE';
let cancelWorks = true;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dkk = (value: string) => ({ currency_code: 'DKK', value });

globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
  const parsed = new URL(String(url));
  assert.equal(parsed.origin, 'https://api-m.sandbox.paypal.com', 'only the fixed sandbox API origin is ever contacted');
  const method = init.method || 'GET';
  calls.push({ method, path: parsed.pathname });
  const body = init.body && String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : null;
  if (parsed.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
  if (parsed.pathname === '/v1/notifications/verify-webhook-signature') {
    if (verifyMode === 'outage') return new Response('{}', { status: 503 });
    return Response.json({ verification_status: verifyMode === 'success' ? 'SUCCESS' : 'FAILURE' });
  }
  if (parsed.pathname === '/v2/checkout/orders' && method === 'POST') {
    orderState.customId = body.purchase_units[0].custom_id;
    return Response.json({ id: 'ORDERSEC', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDERSEC' }] });
  }
  if (parsed.pathname === '/v2/checkout/orders/ORDERSEC' && method === 'GET') return Response.json({ id: 'ORDERSEC', status: orderState.status,
    purchase_units: [{ custom_id: orderState.customId, payee: { merchant_id: orderState.merchant }, amount: { currency_code: orderState.currency, value: orderState.amount },
      ...(orderState.captures ? { payments: { captures: orderState.captures, ...(orderState.refunds ? { refunds: orderState.refunds } : {}) } } : {}) }] });
  if (parsed.pathname === '/v2/checkout/orders/ORDERSEC/capture') {
    await sleep(50);
    orderState = { ...orderState, status: 'COMPLETED', captures: [{ id: 'CAPSEC', status: 'COMPLETED' }] };
    return Response.json({ purchase_units: [{ payments: { captures: [{ id: 'CAPSEC', status: 'COMPLETED' }] } }] });
  }
  if (parsed.pathname === '/v2/payments/captures/CAPSEC') return Response.json({ id: 'CAPSEC', status: orderState.refunds ? 'PARTIALLY_REFUNDED' : 'COMPLETED',
    payee: { merchant_id: 'MERCHANT123' }, supplementary_data: { related_ids: { order_id: 'ORDERSEC' } }, amount: dkk('100.00'),
    seller_receivable_breakdown: { gross_amount: dkk('100.00'), paypal_fee: dkk('4.00'), net_amount: dkk('96.00') }, create_time: '2026-10-08T12:00:00Z' });
  if (parsed.pathname === '/v2/payments/refunds/REFSEC') return Response.json({ id: 'REFSEC', status: 'COMPLETED', amount: dkk('30.00'),
    seller_payable_breakdown: { gross_amount: dkk('30.00'), paypal_fee: dkk('1.00'), net_amount: dkk('29.00'), total_refunded_amount: dkk('30.00') },
    links: [{ rel: 'up', method: 'GET', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPSEC' }], create_time: '2026-10-08T13:00:00Z' });
  if (parsed.pathname === '/v1/billing/subscriptions/SUBSEC' && method === 'GET') return Response.json({ id: 'SUBSEC', plan_id: 'PLANSEC123',
    custom_id: 'sub-intent-sec', status: subscriptionStatus, status_update_time: '2026-10-09T00:00:00Z' });
  if (parsed.pathname === '/v1/billing/subscriptions/SUBSEC/transactions') return Response.json({ total_pages: 1, transactions: [
    { id: 'SALEFAILED', status: 'DECLINED', time: '2026-10-08T12:00:00Z', amount_with_breakdown: { gross_amount: dkk('50.00') } }] });
  if (parsed.pathname === '/v1/billing/subscriptions/SUBSEC/cancel') {
    if (!cancelWorks) return new Response('{}', { status: 503 });
    subscriptionStatus = 'CANCELLED'; return new Response(null, { status: 204 });
  }
  return Response.json({ name: 'RESOURCE_NOT_FOUND' }, { status: 404 });
}) as typeof fetch;

const { default: paymentsRoutes } = await import('./payments.ts');
const { default: webhookRoutes } = await import('./paymentsWebhook.ts');
const { default: adminRoutes } = await import('./admin.ts');
const { DrizzleSessionStore } = await import('../db/sessionStore.ts');
const { authenticateApiToken, enforceApiTokenScope } = await import('../middleware/apiToken.ts');
const { csrfProtection } = await import('../middleware/requestSecurity.ts');
const { enforceTwoFactorEnrollmentOnly } = await import('../middleware/twoFactorEnrollment.ts');
const { requestContext } = await import('../utils/logger.ts');
const { generateApiToken, hashApiToken } = await import('../utils/apiTokens.ts');
const { db } = await import('../db/client.ts');
const paypal = await import('../services/paypal.ts');
const { waitForBackgroundWork } = await import('../services/backgroundWork.ts');
const { monthlyEnergyFunding } = await import('../services/energyFunding.ts');

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
app.use('/api/admin', adminRoutes);

async function login(sid: string, data: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => store.set(sid, { cookie: { originalMaxAge: 86_400_000, expires: new Date(Date.now() + 86_400_000) },
    ...data } as any, (err?: unknown) => (err ? reject(err) : resolve())));
  return `connect.sid=${encodeURIComponent(`s:${signature.sign(sid, SECRET)}`)}`;
}
const ORIGIN = { Origin: 'https://portal.example' };
let member = ''; let admin = ''; let enrollment = ''; let deleted = ''; let revoked = '';
const webhookHeaders = {
  'x-forwarded-proto': 'https', 'content-type': 'application/json', 'paypal-transmission-id': 'TRANSMISSIONSEC',
  'paypal-transmission-time': '2026-10-08T12:01:00Z', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERTSEC',
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': 'fixture-signature',
};
const webhook = (event: unknown, env = 'sandbox') => request(app).post(`/api/payments/paypal/webhook/${env}`).set(webhookHeaders)
  .send(typeof event === 'string' ? event : JSON.stringify(event));
const inboxCount = async () => (await fixture.db.select().from(paypalWebhookInbox)).length;

test.before(async () => {
  await fixture.db.insert(users).values([
    { id: 1, username: 'member-sec', password: 'unused' }, { id: 2, username: 'admin-sec', password: 'unused', is_admin: true },
    { id: 3, username: 'enrolling-sec', password: 'unused' }, { id: 4, username: 'deleted-sec', password: 'unused' },
    { id: 5, username: 'subscriber-sec', password: 'unused' },
  ]);
  member = await login('sid-member', { userId: 1 });
  admin = await login('sid-admin', { userId: 2, reauthenticatedAt: Date.now() });
  enrollment = await login('sid-enrolling', { userId: 3, twoFactorEnrollmentOnly: true });
  deleted = await login('sid-deleted', { userId: 4 });
  revoked = await login('sid-revoked', { userId: 1 });
  await paypal.savePaypalConfiguration({ environment: 'sandbox', clientId: 'CLIENTSEC', clientSecret: 'FIXTURESECRET', merchantId: 'MERCHANT123', webhookId: 'WEBHOOKSEC' });
  await paypal.setPaypalEnabled('sandbox', true);
});

test('anonymous, 2FA-enrollment-only, deleted and revoked sessions cannot read or start payments', async () => {
  for (const path of ['/api/payments/status', '/api/payments/mine', '/api/payments/admin/summary', '/api/payments/admin/review'])
    assert.equal((await request(app).get(path)).status, 401, path);
  assert.equal((await request(app).post('/api/payments/one-off').set(ORIGIN).send({ amount: '100.00', environment: 'sandbox' })).status, 401);
  for (const path of ['/api/payments/mine', '/api/payments/status'])
    assert.equal((await request(app).get(path).set('Cookie', enrollment)).status, 403, `${path} under enrollment-only`);
  assert.equal((await request(app).post('/api/payments/one-off').set('Cookie', enrollment).set(ORIGIN).send({ amount: '100.00', environment: 'sandbox' })).status, 403);
  await fixture.db.delete(users).where(eq(users.id, 4));
  assert.equal((await request(app).get('/api/payments/mine').set('Cookie', deleted)).status, 401, 'a deleted member loses access');
  await new Promise<void>((resolve) => store.destroy('sid-revoked', () => resolve()));
  assert.equal((await request(app).get('/api/payments/mine').set('Cookie', revoked)).status, 401, 'a revoked session loses access');
  assert.equal((await request(app).get('/api/payments/mine').set('Cookie', member)).status, 200);
  assert.equal((await request(app).get('/api/payments/admin/summary').set('Cookie', member)).status, 403);
  assert.equal((await request(app).get('/api/payments/admin/summary').set('Cookie', admin)).status, 200);
});

test('API tokens, even admin-scoped, cannot use member or admin payment routes', async () => {
  for (const [userId, scopes] of [[1, 'read vm:operate'], [2, 'admin']] as const) {
    const token = generateApiToken();
    await fixture.db.insert(apiTokens).values({ user_id: userId, name: `sec-${userId}`, token_hash: hashApiToken(token), scopes });
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await request(app).get('/api/payments/mine').set(auth)).status, 403);
    assert.equal((await request(app).get('/api/payments/status').set(auth)).status, 403);
    assert.equal((await request(app).post('/api/payments/one-off').set(auth).send({ amount: '100.00', environment: 'sandbox' })).status, 403);
    assert.equal((await request(app).get('/api/payments/admin/summary').set(auth)).status, 403);
  }
  assert.equal((await fixture.db.select().from(paypalIntents)).length, 0);
});

test('member mutations still require the browser origin; only the webhook bypasses CSRF', async () => {
  const response = await request(app).post('/api/payments/one-off').set('Cookie', member).send({ amount: '100.00', environment: 'sandbox' });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal((await request(app).post('/api/payments/one-off').set('Cookie', member).set('Origin', 'https://evil.example')
    .send({ amount: '100.00', environment: 'sandbox' })).status, 403);
  const nearMiss = await request(app).post('/api/payments/paypal/webhook-other/sandbox').set(webhookHeaders).send('{}');
  assert.equal(nearMiss.status, 403, 'a near-miss path is not the exempt webhook route');
  assert.equal(nearMiss.body.code, 'ORIGIN_NOT_ALLOWED');
});

test('webhook: malformed, forged, verification outage and DB failure never store or acknowledge', async () => {
  const event = { id: 'WHSEC1', event_type: 'CHECKOUT.ORDER.APPROVED', create_time: '2026-10-08T12:01:00Z', resource: { id: 'ORDERSEC' } };
  assert.equal((await webhook('{not json')).status, 400);
  assert.equal((await webhook({ id: 'WHSEC0', resource: {} })).status, 400);
  assert.equal((await webhook(event, 'production')).status, 400);
  assert.equal((await webhook(event, 'live')).status, 409, 'unconfigured environment');
  assert.equal((await request(app).post('/api/payments/paypal/webhook/sandbox').set({ ...webhookHeaders, 'x-forwarded-proto': 'http' })
    .send(JSON.stringify(event))).status, 403, 'plain HTTP is refused');
  verifyMode = 'failure';
  assert.equal((await webhook(event)).status, 401);
  assert.equal((await webhook(event).set('paypal-cert-url', 'https://evil.example/v1/notifications/certs/CERT')).status, 401);
  verifyMode = 'outage';
  const outage = await webhook(event);
  assert.ok(outage.status >= 500, `verification outage must not acknowledge (got ${outage.status})`);
  assert.equal(await inboxCount(), 0, 'no inbox row without SUCCESS verification');
  verifyMode = 'success';
  await db.execute(sql`ALTER TABLE paypal_webhook_inbox RENAME TO paypal_webhook_inbox_down`);
  try { assert.equal((await webhook(event)).status, 500, 'a database failure is a 5xx so PayPal redelivers'); }
  finally { await db.execute(sql`ALTER TABLE paypal_webhook_inbox_down RENAME TO paypal_webhook_inbox`); }
  assert.equal((await webhook(event)).status, 204);
  assert.equal((await webhook(event)).status, 204, 'stored duplicates are acknowledged');
  assert.equal(await inboxCount(), 1);
  const success = await webhook(event);
  assert.equal(success.text, '', 'acknowledgement reveals nothing');
});

test('capture rejects wrong amount, currency, payee and custom_id; concurrent captures post once', async () => {
  const checkout = await request(app).post('/api/payments/one-off').set('Cookie', member).set(ORIGIN).send({ amount: '100.00', environment: 'sandbox' });
  assert.equal(checkout.status, 201);
  const intentId = checkout.body.intentId;
  const good = { ...orderState };
  for (const bad of [{ amount: '1000.00' }, { currency: 'EUR' }, { merchant: 'OTHERMERCHANT' }, { customId: 'someone-elses-intent' }]) {
    orderState = { ...good, ...bad };
    const response = await request(app).post(`/api/payments/one-off/${intentId}/capture`).set('Cookie', member).set(ORIGIN);
    assert.equal(response.body.error, 'ORDER_MISMATCH', JSON.stringify(bad));
  }
  orderState = good;
  const other = await login('sid-other', { userId: 5 });
  assert.equal((await request(app).post(`/api/payments/one-off/${intentId}/capture`).set('Cookie', other).set(ORIGIN)).status, 404);
  const [first, second] = await Promise.all([1, 2].map(() => request(app).post(`/api/payments/one-off/${intentId}/capture`).set('Cookie', member).set(ORIGIN)));
  // Depending on interleaving the loser sees CAPTURE_ALREADY_STARTED or a
  // pending readback; it must never issue a second provider capture.
  assert.ok([first, second].some((response) => response.status === 200 && response.body.status === 'verified'));
  assert.ok([first, second].every((response) => response.status === 200 || response.body.error === 'CAPTURE_ALREADY_STARTED'));
  assert.equal(calls.filter((call) => call.path === '/v2/checkout/orders/ORDERSEC/capture').length, 1);
  assert.deepEqual((await fixture.db.select().from(paypalPostings)).map((row) => row.amount_ore).sort((a, b) => a - b), [-400, 10000]);
});

test('concurrent inbox workers, refund replay and restore replay produce one economic posting', async () => {
  orderState = { ...orderState, refunds: [{ id: 'REFSEC', status: 'COMPLETED' }] };
  for (const id of ['WHCAP1', 'WHCAP2']) assert.equal((await webhook({ id, event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-10-08T12:02:00Z',
    resource: { id: 'CAPSEC', payee: { merchant_id: 'MERCHANT123' }, supplementary_data: { related_ids: { order_id: 'ORDERSEC' } } } })).status, 204);
  assert.equal((await webhook({ id: 'WHREF1', event_type: 'PAYMENT.CAPTURE.REFUNDED', create_time: '2026-10-08T13:00:00Z', resource: { id: 'REFSEC' } })).status, 204);
  await waitForBackgroundWork();
  await Promise.all([paypal.processPaypalInbox(), paypal.processPaypalInbox(), paypal.processPaypalInbox()]);
  const expected = [-3000, -400, 100, 10000];
  assert.deepEqual((await fixture.db.select().from(paypalPostings)).map((row) => row.amount_ore).sort((a, b) => a - b), expected);
  // A restored backup can bring inbox rows back as pending; replay must not repost.
  await fixture.db.update(paypalWebhookInbox).set({ status: 'pending', processed_at: null, next_attempt_at: null });
  await paypal.processPaypalInbox();
  assert.deepEqual((await fixture.db.select().from(paypalPostings)).map((row) => row.amount_ore).sort((a, b) => a - b), expected);
  const snapshot = await paypal.verifiedContributionSnapshot('sandbox');
  assert.equal(snapshot.knownNetOre, 6700);
  assert.equal(snapshot.eligibleNetOre, 6700);
});

test('sandbox money never reaches live totals', async () => {
  const live = await paypal.verifiedContributionSnapshot('live');
  assert.equal(live.grossOre, 0);
  assert.equal(live.knownNetOre, 0);
  const funding = await monthlyEnergyFunding('2026-10');
  assert.equal(funding.grossOre, 0);
});

test('failed billing posts nothing; external cancellation syncs; deletion is blocked until cancellation is confirmed', async () => {
  await fixture.db.insert(paypalIntents).values({ id: 'sub-intent-sec', user_id: 5, environment: 'sandbox', merchant_id: 'MERCHANT123', kind: 'monthly',
    amount_ore: 5000, status: 'approval_pending', provider_id: 'SUBSEC', create_request_id: 'create-subsec', config_version: 1 });
  await fixture.db.insert(paypalSubscriptions).values({ id: 'SUBSEC', intent_id: 'sub-intent-sec', user_id: 5, environment: 'sandbox',
    merchant_id: 'MERCHANT123', status: 'ACTIVE', plan_id: 'PLANSEC123', amount_ore: 5000 });
  const postingsBefore = (await fixture.db.select().from(paypalPostings)).length;
  assert.equal((await webhook({ id: 'WHFAIL1', event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', create_time: '2026-10-08T12:00:00Z',
    resource: { id: 'SUBSEC' } })).status, 204);
  await waitForBackgroundWork(); await paypal.processPaypalInbox();
  assert.equal((await fixture.db.select().from(paypalPostings)).length, postingsBefore, 'failed/declined billing posts zero');

  cancelWorks = false;
  const blocked = await request(app).delete('/api/admin/users/5').set('Cookie', admin).set(ORIGIN);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'SUBSCRIPTION_CANCELLATION_UNCONFIRMED');
  assert.equal((await fixture.db.select().from(users).where(eq(users.id, 5))).length, 1, 'member and mapping are kept');

  // The member cancels directly at PayPal; the lifecycle webhook synchronizes it.
  subscriptionStatus = 'CANCELLED';
  assert.equal((await webhook({ id: 'WHCANCEL1', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', create_time: '2026-10-09T00:00:00Z',
    resource: { id: 'SUBSEC' } })).status, 204);
  await waitForBackgroundWork(); await paypal.processPaypalInbox();
  const [sub] = await fixture.db.select().from(paypalSubscriptions).where(eq(paypalSubscriptions.id, 'SUBSEC'));
  assert.equal(sub.status, 'CANCELLED');
  const deletedResponse = await request(app).delete('/api/admin/users/5').set('Cookie', admin).set(ORIGIN);
  assert.equal(deletedResponse.status, 200);
  const [orphan] = await fixture.db.select().from(paypalSubscriptions).where(eq(paypalSubscriptions.id, 'SUBSEC'));
  assert.equal(orphan.user_id, null, 'financial record survives without granting anyone access');
});

test('review queue and resync routes are admin-only and reauth-gated where destructive', async () => {
  assert.equal((await request(app).get('/api/payments/admin/review?environment=sandbox').set('Cookie', member)).status, 403);
  assert.equal((await request(app).get('/api/payments/admin/review?environment=sandbox').set('Cookie', admin)).status, 200);
  const stale = await login('sid-admin-stale', { userId: 2 });
  const dismiss = await request(app).post('/api/payments/admin/review/sandbox:MERCHANT123:WHSEC1/dismiss').set('Cookie', stale).set(ORIGIN)
    .send({ environment: 'sandbox', note: 'not ours' });
  assert.equal(dismiss.body.code, 'REAUTHENTICATION_REQUIRED');
});

test('webhook ingress is rate limited without revealing anything', async () => {
  let limited = null;
  for (let index = 0; index < 60 && !limited; index++) {
    const response = await request(app).post('/api/payments/paypal/webhook/sandbox').set(webhookHeaders).send('{not json');
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, 'flooding the webhook is throttled');
  assert.equal(limited.text, 'Too Many Requests');
});

test('admin health and CSV export are admin-only, reauth-gated and formula-safe', async () => {
  assert.equal((await request(app).get('/api/payments/admin/health?environment=sandbox').set('Cookie', member)).status, 403);
  const health = await request(app).get('/api/payments/admin/health?environment=sandbox').set('Cookie', admin);
  assert.equal(health.status, 200);
  assert.equal(typeof health.body.unresolvedTransactions, 'number');
  const stale = await login('sid-admin-stale-export', { userId: 2 });
  assert.equal((await request(app).get('/api/payments/admin/export.csv?environment=sandbox').set('Cookie', stale)).body.code, 'REAUTHENTICATION_REQUIRED');
  await fixture.db.update(users).set({ username: '=HYPERLINK("http://evil")' }).where(eq(users.id, 1));
  const csv = await request(app).get('/api/payments/admin/export.csv?environment=sandbox').set('Cookie', admin);
  assert.equal(csv.status, 200);
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil"")"`), 'member text cannot become a formula');
  assert.ok(csv.text.includes(',-4.00,'), 'negative amounts stay numeric');
  assert.equal((await request(app).get('/api/payments/admin/export.csv?environment=other').set('Cookie', admin)).status, 400);
});
