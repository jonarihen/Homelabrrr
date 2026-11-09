import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import signature from 'cookie-signature';
import { eq, like } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { KOFI_TEST_TOKEN, kofiEvent, kofiFormBody, kofiKey, kofiShopOrderEvent } from '../testUtils/kofiFixtures.ts';
import { apiTokens, auditLog, kofiConfig, kofiMemberEmails, paypalPostings, paypalTransactions, paypalWebhookInbox, users } from '../db/schema/index.ts';

// Ko-fi security coverage on the REAL middleware stack, in the same order as
// src/index.ts: both provider ingresses, then JSON, cookie session or Bearer
// token, token scope, CSRF origin check, live-user hydration, the
// 2FA-enrollment lock and the payments router. Throwaway PostgreSQL, no network.
process.env.SECRET_ENCRYPTION_KEY = '7a'.repeat(32);
process.env.ALLOWED_ORIGIN = 'https://portal.example';
process.env.KOFI_WEBHOOK_RATE_LIMIT_PER_MINUTE = '20';
process.env.KOFI_WEBHOOK_GLOBAL_RATE_LIMIT_PER_MINUTE = '200';
const SECRET = 'kofi-security-session-secret';
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());
globalThis.fetch = (async (url: string | URL | Request) => { throw new Error(`unexpected network call to ${String(url)}`); }) as typeof fetch;

const { default: paymentsRoutes } = await import('./payments.ts');
const { default: kofiAdminRoutes } = await import('./kofi.ts');
const { default: paypalWebhookRoutes } = await import('./paymentsWebhook.ts');
const { default: kofiWebhookRoutes } = await import('./kofiWebhook.ts');
const { DrizzleSessionStore } = await import('../db/sessionStore.ts');
const { authenticateApiToken, enforceApiTokenScope } = await import('../middleware/apiToken.ts');
const { csrfProtection } = await import('../middleware/requestSecurity.ts');
const { enforceTwoFactorEnrollmentOnly } = await import('../middleware/twoFactorEnrollment.ts');
const { requestContext } = await import('../utils/logger.ts');
const { generateApiToken, hashApiToken } = await import('../utils/apiTokens.ts');
const { decryptSecret, isEncryptedSecret } = await import('../utils/secrets.ts');
const { db } = await import('../db/client.ts');
const kofi = await import('../services/kofi.ts');
const kofiAdmin = await import('../services/kofiAdmin.ts');
const { waitForBackgroundWork } = await import('../services/backgroundWork.ts');

const store = new DrizzleSessionStore();
const app = express();
app.set('trust proxy', 1);
app.use(requestContext);
app.use('/api/payments/paypal/webhook', paypalWebhookRoutes);
app.use('/api/payments/kofi/webhook', kofiWebhookRoutes);
app.use(express.json({ limit: '1mb' }));
const sessionMiddleware = session({ store, secret: SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 24 * 60 * 60 * 1000 } });
app.use((req, res, next) => (/^Bearer\s+/i.test(req.headers.authorization || '') ? authenticateApiToken(req, res, next) : sessionMiddleware(req, res, next)));
app.use(enforceApiTokenScope);
app.use(csrfProtection({ allowedOrigin: process.env.ALLOWED_ORIGIN }));
app.use(async (req, _res, next) => {
  if (!req.session?.userId || req.apiToken) return next();
  const [user] = await db.select({ username: users.username, is_admin: users.is_admin }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!user) return req.session.destroy(() => next());
  req.session.username = user.username; req.session.isAdmin = user.is_admin === true;
  next();
});
app.use(enforceTwoFactorEnrollmentOnly);
app.use('/api/payments', paymentsRoutes);

async function login(sid: string, data: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => store.set(sid, { cookie: { originalMaxAge: 86_400_000, expires: new Date(Date.now() + 86_400_000) },
    ...data } as any, (err?: unknown) => (err ? reject(err) : resolve())));
  return `connect.sid=${encodeURIComponent(`s:${signature.sign(sid, SECRET)}`)}`;
}
const ORIGIN = { Origin: 'https://portal.example' };
const MEMBER = 1; const ADMIN = 2; const BIRGIT = 3;
const MEMBER_EMAIL = 'member.sec@example.dk';
let member = ''; let admin = ''; let stale = '';

// Each test posts from its own client address, so the per-client limit of one test never spills into another.
const hook = (event: unknown, ip: string, proto = 'https') => request(app).post('/api/payments/kofi/webhook')
  .set({ 'x-forwarded-proto': proto, 'x-forwarded-for': ip }).type('form').send(kofiFormBody(event));
async function deliver(event: Record<string, unknown>, ip: string) {
  assert.equal((await hook(event, ip)).status, 200);
  await waitForBackgroundWork();
  await kofi.processKofiInbox();
  return `live:kofi:${String(event.message_id)}`;
}
const inboxCount = async () => (await fixture.db.select().from(paypalWebhookInbox)).length;
const receiptFor = async (event: Record<string, unknown>) => (await fixture.db.select().from(paypalTransactions)
  .where(eq(paypalTransactions.provider_transaction_id, kofiKey(event.kofi_transaction_id))))[0];
const reviewPath = (id: string, action: string) => `/review/${encodeURIComponent(id)}/${action}`;
const as = (cookie: string) => ({
  get: (path: string) => request(app).get(`/api/payments/admin/kofi${path}`).set('Cookie', cookie),
  post: (path: string, body: unknown = {}) => request(app).post(`/api/payments/admin/kofi${path}`).set('Cookie', cookie).set(ORIGIN).send(body as object),
  delete: (path: string) => request(app).delete(`/api/payments/admin/kofi${path}`).set('Cookie', cookie).set(ORIGIN),
});

// Every route the payments router serves, read from the routers themselves so
// a route added later is covered without editing this list.
type RouteRef = { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string };
function routesOf(router: any, prefix: string): RouteRef[] {
  const found: RouteRef[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) found.push({ method: method as RouteRef['method'], path: `${prefix}${String(layer.route.path)}` });
  }
  return found;
}
const KOFI_ADMIN_ROUTES = routesOf(kofiAdminRoutes, '/api/payments/admin/kofi');
const ALL_ROUTES = [...routesOf(paymentsRoutes, '/api/payments'), ...KOFI_ADMIN_ROUTES];
const concrete = (path: string) => path.replace(/\/review\/:id\//, '/review/live%3Akofi%3Asample/').replace(/:[A-Za-z]+/g, '1');
const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(new Date());

test.before(async () => {
  await fixture.db.insert(users).values([
    { id: MEMBER, username: 'member-kofi-sec', password: 'unused' }, { id: ADMIN, username: 'admin-kofi-sec', password: 'unused', is_admin: true },
    { id: BIRGIT, username: 'birgit-kofi-sec', password: 'unused' },
  ]);
  member = await login('sid-member', { userId: MEMBER });
  admin = await login('sid-admin', { userId: ADMIN, reauthenticatedAt: Date.now() });
  stale = await login('sid-admin-stale', { userId: ADMIN });
  await kofi.saveKofiConfiguration({ pageUrl: 'https://ko-fi.com/homelab', verificationToken: KOFI_TEST_TOKEN }, ADMIN);
  await kofi.setKofiEnabled(true, ADMIN);
  await kofiAdmin.addKofiMemberEmail({ userId: MEMBER, email: MEMBER_EMAIL }, ADMIN);
});

test('only POST /api/payments/kofi/webhook is public; every other payments route still requires a session', async () => {
  assert.ok(ALL_ROUTES.length >= 45, `route enumeration found ${ALL_ROUTES.length} routes`);
  for (const expected of ['get /api/payments/status', 'get /api/payments/mine', 'post /api/payments/manual-reports', 'get /api/payments/admin/summary',
    'get /api/payments/admin/kofi/config', 'post /api/payments/admin/kofi/config', 'post /api/payments/admin/kofi/enabled',
    'get /api/payments/admin/kofi/review', 'post /api/payments/admin/kofi/review/:id/link', 'post /api/payments/admin/kofi/review/:id/settle',
    'post /api/payments/admin/kofi/review/:id/retry', 'post /api/payments/admin/kofi/review/:id/dismiss', 'get /api/payments/admin/kofi/receipts',
    'post /api/payments/admin/kofi/receipts/:id/fee', 'post /api/payments/admin/kofi/receipts/:id/reverse', 'get /api/payments/admin/kofi/members',
    'post /api/payments/admin/kofi/members', 'delete /api/payments/admin/kofi/members/:id'])
    assert.ok(ALL_ROUTES.some((route) => `${route.method} ${route.path}` === expected), `${expected} is covered`);
  assert.equal(KOFI_ADMIN_ROUTES.length, 14, 'every Ko-fi admin route is in the list above');
  for (const route of ALL_ROUTES) {
    const anonymous = request(app)[route.method](concrete(route.path));
    const response = await (route.method === 'get' ? anonymous : anonymous.set(ORIGIN).send({}));
    assert.equal(response.status, 401, `${route.method} ${route.path} without a session`);
    assert.deepEqual(response.body, { error: 'Unauthorized' });
  }
  // The one Ko-fi path that answers an anonymous caller, and only with the right token.
  const before = await inboxCount();
  assert.equal((await hook(kofiEvent({ email: MEMBER_EMAIL }), '198.51.100.1')).status, 200);
  assert.equal((await hook(kofiEvent({ verification_token: 'guess' }), '198.51.100.1')).status, 401);
  await waitForBackgroundWork();
  assert.equal(await inboxCount(), before + 1);
});

test('near-miss webhook paths and other methods are not exempt from session and CSRF', async () => {
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.2' };
  const body = kofiFormBody(kofiEvent({ email: MEMBER_EMAIL }));
  const before = await inboxCount();
  for (const path of ['/api/payments/kofi/webhook-other', '/api/payments/kofi/webhook/extra', '/api/payments/kofi/webhooks', '/api/payments/kofi',
    '/api/payments/kofi/webhook/../admin/kofi/config']) {
    const response = await request(app).post(path).set(headers).type('form').send(body);
    assert.equal(response.status, 403, `${path} is not the exempt route`);
    assert.equal(response.body.code, 'ORIGIN_NOT_ALLOWED');
  }
  // With the portal origin the near-miss still needs a session; the valid token buys nothing there.
  assert.equal((await request(app).post('/api/payments/kofi/webhook-other').set(headers).set(ORIGIN).type('form').send(body)).status, 401);
  assert.equal((await request(app).get('/api/payments/kofi/webhook').set(headers)).status, 401, 'GET is not served by the ingress');
  for (const method of ['put', 'patch', 'delete'] as const) {
    const response = await request(app)[method]('/api/payments/kofi/webhook').set(headers).type('form').send(body);
    assert.equal(response.status, 403, `${method} falls through to CSRF`);
  }
  // A token in the query string or a header is not a credential.
  assert.equal((await request(app).get(`/api/payments/admin/kofi/config?verification_token=${KOFI_TEST_TOKEN}`).set(headers)).status, 401);
  assert.equal((await request(app).get('/api/payments/admin/kofi/config').set(headers).set('Authorization', `Bearer ${KOFI_TEST_TOKEN}`)).status, 401);
  await waitForBackgroundWork();
  assert.equal(await inboxCount(), before, 'nothing was stored through a near-miss path');
});

test('the verification token and email hash key are never returned by any GET and never stored in the inbox', async () => {
  const ip = '198.51.100.3';
  // Fill every list: a recorded receipt, a linked review item, a settled foreign payment and open review items.
  const paid = kofiEvent({ email: MEMBER_EMAIL, amount: '50.00' });
  await deliver(paid, ip);
  const linkId = await deliver(kofiEvent({ email: 'someone.new@example.dk', amount: '20.00' }), ip);
  assert.equal((await as(admin).post(reviewPath(linkId, 'link'), { userId: BIRGIT })).status, 200);
  const euroId = await deliver(kofiEvent({ email: 'euro@example.de', currency: 'EUR', amount: '5.00' }), ip);
  assert.equal((await as(admin).post(reviewPath(euroId, 'settle'), { userId: BIRGIT, grossDkk: '37.25', fee: '1.95' })).status, 200);
  await deliver(kofiShopOrderEvent({ email: 'buyer@example.org' }), ip);
  await deliver(kofiEvent({ email: 'unknown@example.org', note: KOFI_TEST_TOKEN }), ip);
  assert.equal((await as(admin).post(`/receipts/${(await receiptFor(paid)).id}/fee`, { fee: '1.95' })).status, 200);

  const [config] = await fixture.db.select().from(kofiConfig);
  assert.ok(isEncryptedSecret(config.verification_token), 'the token is encrypted at rest');
  assert.ok(isEncryptedSecret(config.email_hash_key), 'the hash key is encrypted at rest');
  assert.equal(decryptSecret(config.verification_token!), KOFI_TEST_TOKEN);
  const hashKey = decryptSecret(config.email_hash_key!);
  const hashes = (await fixture.db.select().from(kofiMemberEmails)).map((row) => row.email_hash);
  assert.ok(hashes.length >= 3 && hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  const forbidden = [KOFI_TEST_TOKEN, hashKey, config.verification_token!, config.email_hash_key!, 'enc:v2:', 'enc:v1:', ...hashes];
  const clean = (text: string, where: string) => { for (const secret of forbidden) assert.equal(text.includes(secret), false, `${where} leaks a secret`); };

  const gets = ALL_ROUTES.filter((route) => route.method === 'get');
  assert.ok(gets.length >= 16);
  for (const route of gets) {
    const url = `${concrete(route.path)}?environment=live&status=all&month=${month}&offset=0`;
    const response = await request(app).get(url).set('Cookie', admin);
    assert.equal(response.status, 200, `${route.path} answered`);
    clean(response.text, `GET ${route.path}`);
    clean(JSON.stringify(response.headers), `GET ${route.path} headers`);
  }
  for (const path of ['/api/payments/status', '/api/payments/mine']) clean((await request(app).get(path).set('Cookie', member)).text, `member GET ${path}`);
  // The status object returned by the config mutations says only whether a token is stored.
  const saved = await as(admin).post('/config', { pageUrl: 'https://ko-fi.com/homelab', verificationToken: KOFI_TEST_TOKEN });
  assert.equal(saved.body.tokenStored, true);
  clean(saved.text, 'POST /config');
  clean((await as(admin).post('/enabled', { enabled: true })).text, 'POST /enabled');
  assert.deepEqual(Object.keys((await as(admin).get('/config')).body).sort(), ['configured', 'counts', 'enabled', 'lastErrorAt', 'lastErrorCode', 'lastEventAt',
    'lastEventOutcome', 'lastEventType', 'lastTestEventAt', 'pageUrl', 'tokenStored', 'tokenUpdatedAt', 'updatedAt', 'webhookUrl', 'webhookUrlError']);
  const memberItems = (await as(admin).get('/members')).body.items;
  assert.deepEqual(Object.keys(memberItems[0]).sort(), ['emailHint', 'id', 'source', 'userId', 'username', 'verifiedAt'], 'only the masked hint leaves the server');
  assert.ok(memberItems.every((item: any) => /^.{1,2}…@/.test(item.emailHint)));

  for (const row of await fixture.db.select().from(paypalWebhookInbox)) {
    const stored = JSON.stringify(row);
    assert.equal(stored.includes(KOFI_TEST_TOKEN), false, 'no inbox row holds the token');
    assert.equal(stored.includes('verification_token'), false);
    assert.equal(stored.includes('Secret Street'), false, 'no inbox row holds the postal address');
    assert.equal('shipping' in (row.payload as object), false);
  }
});

test('Ko-fi admin routes are admin-only and refuse API tokens', async () => {
  const tokens: string[] = [];
  for (const [userId, scopes] of [[MEMBER, 'read vm:operate'], [ADMIN, 'admin']] as const) {
    const token = generateApiToken();
    await fixture.db.insert(apiTokens).values({ user_id: userId, name: `kofi-sec-${userId}`, token_hash: hashApiToken(token), scopes });
    tokens.push(token);
  }
  const before = JSON.stringify(await fixture.db.select().from(kofiConfig));
  for (const route of KOFI_ADMIN_ROUTES) {
    const call = (headers: Record<string, string>) => {
      const pending = request(app)[route.method](concrete(route.path)).set(headers);
      return route.method === 'get' ? pending : pending.set(ORIGIN).send({ enabled: false, pageUrl: 'https://ko-fi.com/other', userId: MEMBER, note: 'not allowed', fee: '1.00' });
    };
    const asMember = await call({ Cookie: member });
    assert.equal(asMember.status, 403, `${route.method} ${route.path} as a member`);
    assert.deepEqual(asMember.body, { error: 'Forbidden' });
    for (const token of tokens) assert.equal((await call({ Authorization: `Bearer ${token}` })).status, 403, `${route.method} ${route.path} with an API token`);
  }
  assert.equal(JSON.stringify(await fixture.db.select().from(kofiConfig)), before, 'nothing changed');
  // The member endpoints are session-only as well.
  for (const token of tokens) for (const path of ['/api/payments/status', '/api/payments/mine'])
    assert.equal((await request(app).get(path).set('Authorization', `Bearer ${token}`)).status, 403);
});

test('config save, toggle, dismiss, fee entry, reversal and settlement require recent reauthentication', async () => {
  const ip = '198.51.100.5';
  const paid = kofiEvent({ email: MEMBER_EMAIL, amount: '45.00' });
  await deliver(paid, ip);
  const receipt = await receiptFor(paid);
  const reviewId = await deliver(kofiEvent({ email: MEMBER_EMAIL, type: 'Commission' }), ip);
  const euroId = await deliver(kofiEvent({ email: MEMBER_EMAIL, currency: 'EUR', amount: '4.00' }), ip);
  const unmatchedId = await deliver(kofiEvent({ email: 'reauth.unmatched@example.dk', amount: '15.00' }), ip);
  const snapshot = async () => JSON.stringify([await fixture.db.select().from(kofiConfig), await fixture.db.select().from(paypalPostings),
    (await fixture.db.select().from(paypalTransactions)).map((row) => [row.id, row.status]),
    (await fixture.db.select().from(paypalWebhookInbox)).map((row) => [row.id, row.status])]);
  const before = await snapshot();
  const gated: Array<[string, unknown]> = [
    ['/config', { pageUrl: 'https://ko-fi.com/other', verificationToken: 'another-token-value' }],
    ['/enabled', { enabled: false }],
    [reviewPath(reviewId, 'dismiss'), { note: 'not lab income' }],
    [reviewPath(euroId, 'settle'), { userId: MEMBER, grossDkk: '29.80', fee: '1.20' }],
    [`/receipts/${receipt.id}/fee`, { fee: '1.50' }],
    [`/receipts/${receipt.id}/reverse`, { reason: 'refunded to the supporter' }],
  ];
  for (const [path, body] of gated) {
    const response = await as(stale).post(path, body);
    assert.deepEqual([response.status, response.body.code], [403, 'REAUTHENTICATION_REQUIRED'], path);
  }
  assert.equal(await snapshot(), before, 'a stale session changed nothing');
  // Reads, linking, retry and the email list do not post money and need no reauthentication.
  for (const path of ['/config', '/review', '/receipts', '/members']) assert.equal((await as(stale).get(path)).status, 200, path);
  assert.equal((await as(stale).post(reviewPath(unmatchedId, 'link'), { userId: BIRGIT })).status, 200);
  assert.equal((await as(stale).post(reviewPath(reviewId, 'retry'))).status, 200);
  const added = await as(stale).post('/members', { userId: BIRGIT, email: 'reauth.added@example.dk' });
  assert.equal(added.status, 201);
  assert.equal((await as(stale).delete(`/members/${added.body.id}`)).status, 200);
  // With a recent reauthentication the same requests go through.
  await waitForBackgroundWork(); await kofi.processKofiInbox();
  assert.equal((await as(admin).post(reviewPath(reviewId, 'dismiss'), { note: 'not lab income' })).status, 200);
  assert.equal((await as(admin).post(reviewPath(euroId, 'settle'), { userId: MEMBER, grossDkk: '29.80', fee: '1.20' })).status, 200);
  assert.equal((await as(admin).post(`/receipts/${receipt.id}/fee`, { fee: '1.50' })).status, 200);
  assert.equal((await as(admin).post(`/receipts/${receipt.id}/reverse`, { reason: 'refunded to the supporter' })).status, 200);
});

test('the webhook refuses plain HTTP, oversized bodies and malformed bodies without storing', async () => {
  const ip = '198.51.100.6'; const other = '198.51.100.60';
  const before = await inboxCount();
  const post = (body: string, type = 'form', from = ip) => request(app).post('/api/payments/kofi/webhook')
    .set({ 'x-forwarded-proto': 'https', 'x-forwarded-for': from }).type(type).send(body);
  const empty = (response: { status: number; text: string }, status: number, what: string) => {
    assert.equal(response.status, status, what);
    assert.equal(response.text, '', `${what}: empty body`);
  };
  // A valid token with a missing or malformed message_id is malformed, and is remembered as such.
  const { message_id: _id, ...noMessageId } = kofiEvent({ email: MEMBER_EMAIL });
  empty(await post(kofiFormBody(noMessageId)), 400, 'no message_id');
  const [config] = await fixture.db.select().from(kofiConfig);
  assert.equal(config.last_rejected_code, 'MALFORMED');
  assert.ok(config.last_rejected_at && Date.now() - config.last_rejected_at.getTime() < 60_000);
  for (const message_id of ['has space', 'semi;colon', 'x'.repeat(129), '', 42, null, ['a']])
    empty(await post(kofiFormBody(kofiEvent({ email: MEMBER_EMAIL, message_id }))), 400, `message_id ${JSON.stringify(message_id).slice(0, 20)}`);

  empty(await hook(kofiEvent({ email: MEMBER_EMAIL }), ip, 'http'), 403, 'plain HTTP');
  empty(await post(`data=${'a'.repeat(70_000)}`), 413, 'oversized body');
  empty(await post(JSON.stringify(kofiEvent({ email: MEMBER_EMAIL })), 'json', other), 400, 'JSON instead of a form');
  empty(await post(JSON.stringify({ data: JSON.stringify(kofiEvent({ email: MEMBER_EMAIL })) }), 'json', other), 400, 'JSON wrapper');
  empty(await post('', 'form', other), 400, 'empty form');
  empty(await post(`payload=${encodeURIComponent(JSON.stringify(kofiEvent()))}`, 'form', other), 400, 'wrong field name');
  for (const data of ['not json', '[1,2]', '"text"', 'null', '42', '{"verification_token":'])
    empty(await post(kofiFormBody(data), 'form', other), 400, `data=${data}`);
  const twice = kofiFormBody(kofiEvent({ email: MEMBER_EMAIL }));
  empty(await post(`${twice}&${twice}`, 'form', other), 400, 'the data field twice');
  empty(await post(kofiFormBody(kofiEvent({ email: MEMBER_EMAIL })), 'text/plain', other), 400, 'text/plain');
  await waitForBackgroundWork();
  assert.equal(await inboxCount(), before, 'nothing was stored');

  // Refusals are remembered for the status panel at most once a minute per reason.
  const t0 = Date.now() + 10 * 60_000;
  await kofi.recordKofiRejection('DISABLED', t0);
  assert.equal((await fixture.db.select().from(kofiConfig))[0].last_rejected_code, 'DISABLED');
  await fixture.db.update(kofiConfig).set({ last_rejected_code: 'MARKER' });
  await kofi.recordKofiRejection('DISABLED', t0 + 59_000);
  assert.equal((await fixture.db.select().from(kofiConfig))[0].last_rejected_code, 'MARKER', 'throttled within the minute');
  await kofi.recordKofiRejection('DISABLED', t0 + 61_000);
  assert.equal((await fixture.db.select().from(kofiConfig))[0].last_rejected_code, 'DISABLED');
  await fixture.db.update(kofiConfig).set({ last_rejected_code: null, last_rejected_at: null });
});

test('audit rows for Ko-fi actions contain no token, email or note text', async () => {
  const ip = '198.51.100.8';
  const NEW_TOKEN = 'rotated-token-9f8e7d6c5b4a';
  const notes = ['DISMISS-NOTE-zebra', 'FEE-NOTE-giraffe', 'REVERSE-REASON-walrus', 'SETTLE-NOTE-ostrich'];
  const emails = ['audit.payer@example.dk', 'audit.euro@example.de', 'audit.added@example.dk'];
  await fixture.db.delete(auditLog);
  assert.equal((await as(admin).post('/config', { pageUrl: 'https://ko-fi.com/homelab', verificationToken: NEW_TOKEN })).status, 200);
  assert.equal((await as(admin).post('/config', { pageUrl: 'https://ko-fi.com/homelab', verificationToken: KOFI_TEST_TOKEN })).status, 200);
  assert.equal((await as(admin).post('/config', { pageUrl: 'https://ko-fi.com/homelab' })).status, 200);
  assert.equal((await as(admin).post('/enabled', { enabled: true })).status, 200);
  const unmatched = kofiEvent({ email: emails[0], amount: '33.00', from_name: 'Payer Person', message: 'PAYER-MESSAGE-llama' });
  const linkId = await deliver(unmatched, ip);
  assert.equal((await as(admin).post(reviewPath(linkId, 'link'), { userId: BIRGIT })).status, 200);
  const commissionId = await deliver(kofiEvent({ email: emails[0], type: 'Commission' }), ip);
  assert.equal((await as(admin).post(reviewPath(commissionId, 'retry'))).status, 200);
  await waitForBackgroundWork(); await kofi.processKofiInbox();
  assert.equal((await as(admin).post(reviewPath(commissionId, 'dismiss'), { note: notes[0] })).status, 200);
  const receipt = await receiptFor(unmatched);
  assert.equal((await as(admin).post(`/receipts/${receipt.id}/fee`, { fee: '1.10', note: notes[1] })).status, 200);
  assert.equal((await as(admin).post(`/receipts/${receipt.id}/reverse`, { reason: notes[2] })).status, 200);
  const euroId = await deliver(kofiEvent({ email: emails[1], currency: 'EUR', amount: '5.00' }), ip);
  assert.equal((await as(admin).post(reviewPath(euroId, 'settle'), { userId: MEMBER, grossDkk: '37.25', fee: '1.95', note: notes[3] })).status, 200);
  const added = await as(admin).post('/members', { userId: BIRGIT, email: emails[2] });
  assert.equal(added.status, 201);
  assert.equal((await as(admin).delete(`/members/${added.body.id}`)).status, 200);

  const rows = await fixture.db.select().from(auditLog).where(like(auditLog.action, 'kofi.%')).orderBy(auditLog.id);
  assert.deepEqual(rows.map((row) => [row.action, row.target]), [
    ['kofi.config.save', 'token_replaced'], ['kofi.config.save', 'token_replaced'], ['kofi.config.save', 'page_url'], ['kofi.toggle', 'on'],
    ['kofi.review.link', linkId], ['kofi.review.retry', commissionId], ['kofi.review.dismiss', commissionId],
    ['kofi.receipt.fee', `receipt:${receipt.id}`], ['kofi.receipt.reverse', `receipt:${receipt.id}`], ['kofi.review.settle', euroId],
    ['kofi.member_email.add', `member_email:${added.body.id}`], ['kofi.member_email.remove', `member_email:${added.body.id}`],
  ]);
  assert.ok(rows.every((row) => row.user_id === ADMIN && row.username === 'admin-kofi-sec' && row.outcome === 'success'));
  // Nothing in the whole audit trail (including denials written by other middleware) carries a secret or payer data.
  const trail = JSON.stringify(await fixture.db.select().from(auditLog));
  for (const secret of [KOFI_TEST_TOKEN, NEW_TOKEN, ...notes, ...emails, 'Payer Person', 'PAYER-MESSAGE-llama', 'enc:v2:'])
    assert.equal(trail.includes(secret), false, `the audit trail contains ${secret.slice(0, 12)}…`);
  // The notes are kept where they belong: in the payments tables.
  const [dismissed] = await fixture.db.select().from(paypalWebhookInbox).where(eq(paypalWebhookInbox.id, commissionId));
  assert.equal(dismissed.resolution_note, notes[0]);
  const [reversed] = await fixture.db.select().from(paypalTransactions).where(eq(paypalTransactions.id, receipt.id));
  assert.equal(reversed.admin_note, `${notes[1]}\nReversed: ${notes[2]}`);
});

// Last on purpose: it exhausts the ingress limits for the rest of the minute.
test('the webhook is rate limited per client and globally with an empty response', async () => {
  const before = await inboxCount();
  const wrong = () => kofiEvent({ verification_token: 'wrong-token' });
  // One client: the configured 20 requests pass (and are refused for the token), the next is throttled.
  const client = '203.0.113.50';
  for (let index = 0; index < 20; index++) assert.equal((await hook(wrong(), client)).status, 401, `request ${index + 1} is within the limit`);
  const throttled = await hook(wrong(), client);
  assert.deepEqual([throttled.status, throttled.text], [429, '']);
  const valid = await hook(kofiEvent({ email: MEMBER_EMAIL }), client);
  assert.deepEqual([valid.status, valid.text], [429, ''], 'even a valid event is throttled; Ko-fi will deliver it again');
  assert.equal((await hook(wrong(), '203.0.113.51')).status, 401, 'another client is not affected');

  // Many clients: the limit across all clients (200) trips although each client is new.
  let seen = 0; let limited: { status: number; text: string } | null = null;
  for (let index = 0; index < 220 && !limited; index++) {
    const response = await hook(wrong(), `203.0.114.${index + 1}`);
    if (response.status === 429) limited = response; else { assert.equal(response.status, 401); seen += 1; }
  }
  assert.ok(limited, 'the global limit was reached');
  assert.ok(seen > 0 && seen < 200, `${seen} fresh clients passed before the global limit`);
  assert.equal(limited!.text, '');
  const blocked = await hook(kofiEvent({ email: MEMBER_EMAIL }), '203.0.115.1');
  assert.deepEqual([blocked.status, blocked.text], [429, ''], 'a new client with a valid event is throttled too');
  await waitForBackgroundWork();
  assert.equal(await inboxCount(), before, 'throttled requests store nothing');
});
