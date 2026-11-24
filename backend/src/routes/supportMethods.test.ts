import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import signature from 'cookie-signature';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { auditLog, manualContributions, paypalConfigs, paypalIntents, paypalSubscriptions, settings, users } from '../db/schema/index.ts';

// The owner's switches for the member-facing support methods, on the real
// session, CSRF and payments router stack. Throwaway PostgreSQL, no network.
process.env.SECRET_ENCRYPTION_KEY = '5c'.repeat(32);
process.env.ALLOWED_ORIGIN = 'https://portal.example';
const SECRET = 'support-methods-session-secret';
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());
globalThis.fetch = (async (url: string | URL | Request) => { throw new Error(`unexpected network call to ${String(url)}`); }) as typeof fetch;

const { default: paymentsRoutes } = await import('./payments.ts');
const { DrizzleSessionStore } = await import('../db/sessionStore.ts');
const { csrfProtection } = await import('../middleware/requestSecurity.ts');
const { requestContext } = await import('../utils/logger.ts');
const { db } = await import('../db/client.ts');
const kofi = await import('../services/kofi.ts');
const { BANK_TRANSFER_SETTING, bankTransferEnabled } = await import('../services/supportMethods.ts');

const store = new DrizzleSessionStore();
const app = express();
app.set('trust proxy', 1);
app.use(requestContext);
app.use(express.json({ limit: '1mb' }));
app.use(session({ store, secret: SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 24 * 60 * 60 * 1000 } }));
app.use(csrfProtection({ allowedOrigin: process.env.ALLOWED_ORIGIN }));
app.use(async (req, _res, next) => {
  if (!req.session?.userId) return next();
  const [user] = await db.select({ username: users.username, is_admin: users.is_admin }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!user) return req.session.destroy(() => next());
  req.session.username = user.username; req.session.isAdmin = user.is_admin === true;
  next();
});
app.use('/api/payments', paymentsRoutes);

async function login(sid: string, data: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => store.set(sid, { cookie: { originalMaxAge: 86_400_000, expires: new Date(Date.now() + 86_400_000) },
    ...data } as any, (err?: unknown) => (err ? reject(err) : resolve())));
  return `connect.sid=${encodeURIComponent(`s:${signature.sign(sid, SECRET)}`)}`;
}
const ORIGIN = { Origin: 'https://portal.example' };
const MEMBER = 1; const ADMIN = 2; const OTHER = 3;
let member = ''; let admin = ''; let stale = ''; let other = '';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());

const status = async (cookie: string) => (await request(app).get('/api/payments/status').set('Cookie', cookie)).body;
const toggle = (cookie: string, body: unknown) => request(app).post('/api/payments/admin/bank-transfer/enabled').set('Cookie', cookie).set(ORIGIN).send(body as object);
const report = (cookie: string, reference: string) => request(app).post('/api/payments/manual-reports').set('Cookie', cookie).set(ORIGIN)
  .send({ amount: '50.00', reference, receivedOn: today });
const stored = async () => (await fixture.db.select().from(settings).where(eq(settings.key, BANK_TRANSFER_SETTING)))[0]?.value ?? null;

test.before(async () => {
  await fixture.db.insert(users).values([
    { id: MEMBER, username: 'member-support', password: 'unused' }, { id: ADMIN, username: 'admin-support', password: 'unused', is_admin: true },
    { id: OTHER, username: 'other-support', password: 'unused' },
  ]);
  member = await login('sid-member', { userId: MEMBER });
  other = await login('sid-other', { userId: OTHER });
  admin = await login('sid-admin', { userId: ADMIN, reauthenticatedAt: Date.now() });
  stale = await login('sid-admin-stale', { userId: ADMIN });
});

test('bank transfer is enabled while the setting is unset, and only the stored string false disables it', async () => {
  assert.equal(await stored(), null);
  assert.equal(await bankTransferEnabled(), true);
  const body = await status(member);
  assert.deepEqual(body.bankTransfer, { enabled: true });
  assert.equal(body.showSupport, true);
  // The fields the member page already relied on are still there.
  assert.deepEqual(body.kofi, { enabled: false, pageUrl: null });
  assert.deepEqual([body.environment, body.checkoutEnabled, body.monthlyAvailable], ['live', false, false]);
  for (const value of ['true', '0', '', 'FALSE', 'off']) {
    await fixture.db.insert(settings).values({ key: BANK_TRANSFER_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    assert.equal(await bankTransferEnabled(), true, `stored ${JSON.stringify(value)} keeps it enabled`);
  }
  await fixture.db.delete(settings).where(eq(settings.key, BANK_TRANSFER_SETTING));
});

test('the toggle requires an administrator with a recent reauthentication, and a boolean', async () => {
  const anonymous = await request(app).post('/api/payments/admin/bank-transfer/enabled').set(ORIGIN).send({ enabled: false });
  assert.equal(anonymous.status, 401);
  const asMember = await toggle(member, { enabled: false });
  assert.deepEqual([asMember.status, asMember.body], [403, { error: 'Forbidden' }]);
  const asStale = await toggle(stale, { enabled: false });
  assert.deepEqual([asStale.status, asStale.body.code], [403, 'REAUTHENTICATION_REQUIRED']);
  for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }]) {
    const invalid = await toggle(admin, body);
    assert.deepEqual([invalid.status, invalid.body], [400, { error: 'INVALID_REQUEST' }], JSON.stringify(body));
  }
  assert.equal(await stored(), null, 'nothing was stored by a refused request');
  assert.equal((await status(member)).bankTransfer.enabled, true);

  await fixture.db.delete(auditLog);
  const off = await toggle(admin, { enabled: false });
  assert.deepEqual([off.status, off.body], [200, { bankTransfer: { enabled: false } }]);
  assert.equal(await stored(), 'false');
  const on = await toggle(admin, { enabled: true });
  assert.deepEqual([on.status, on.body], [200, { bankTransfer: { enabled: true } }]);
  assert.equal(await stored(), 'true');
  const rows = await fixture.db.select().from(auditLog).where(eq(auditLog.action, 'payments.bank_transfer.toggle')).orderBy(auditLog.id);
  assert.deepEqual(rows.map((row) => [row.target, row.user_id]), [['off', ADMIN], ['on', ADMIN]]);
});

test('a member report is refused while the switch is off; administrators can still record and confirm', async () => {
  const accepted = await report(member, 'BANK-ON-0001');
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.status, 'reported');

  assert.equal((await toggle(admin, { enabled: false })).status, 200);
  const before = (await fixture.db.select().from(manualContributions)).length;
  const refused = await report(member, 'BANK-OFF-0002');
  assert.deepEqual([refused.status, refused.body], [403, { error: 'BANK_TRANSFER_DISABLED' }]);
  // Refused before validation: an invalid body gets the same answer, not a 400.
  const invalid = await request(app).post('/api/payments/manual-reports').set('Cookie', member).set(ORIGIN).send({});
  assert.deepEqual([invalid.status, invalid.body], [403, { error: 'BANK_TRANSFER_DISABLED' }]);
  assert.equal((await fixture.db.select().from(manualContributions)).length, before, 'nothing was stored');

  // The admin side is not behind the switch.
  assert.equal((await request(app).get('/api/payments/admin/manual').set('Cookie', admin)).status, 200);
  const confirmed = await request(app).post(`/api/payments/admin/manual/${accepted.body.id}/confirm`).set('Cookie', admin).set(ORIGIN)
    .send({ evidence: 'seen on the bank statement' });
  assert.deepEqual([confirmed.status, confirmed.body.status], [200, 'confirmed']);
  const recorded = await request(app).post('/api/payments/admin/manual').set('Cookie', admin).set(ORIGIN)
    .send({ amount: '75.00', reference: 'BANK-ADMIN-0003', receivedOn: today, evidence: 'seen on the bank statement', userId: MEMBER });
  assert.deepEqual([recorded.status, recorded.body.status], [201, 'confirmed']);
  // The member still sees their own earlier reports.
  assert.equal((await request(app).get('/api/payments/mine').set('Cookie', member)).body.manualReports.length, 2);

  assert.equal((await toggle(admin, { enabled: true })).status, 200);
  assert.equal((await report(member, 'BANK-ON-0004')).status, 201);
});

test('/status reports each switch and whether the support page has anything to show', async () => {
  const subscription = async (id: string, userId: number, environment: string, state: string) => {
    await fixture.db.insert(paypalIntents).values({ id: `intent-${id}`, user_id: userId, environment, merchant_id: 'MERCHANT123', kind: 'monthly',
      amount_ore: 5000, status: 'approval_pending', provider_id: id, create_request_id: `create-${id}`, config_version: 1 });
    await fixture.db.insert(paypalSubscriptions).values({ id, intent_id: `intent-${id}`, user_id: userId, environment, merchant_id: 'MERCHANT123',
      status: state, plan_id: 'PLAN123', amount_ore: 5000 });
  };
  const flags = async (cookie: string) => { const body = await status(cookie);
    return [body.checkoutEnabled, body.kofi.enabled, body.bankTransfer.enabled, body.showSupport]; };

  // Everything off: nothing to show.
  assert.equal((await toggle(admin, { enabled: false })).status, 200);
  assert.deepEqual(await flags(member), [false, false, false, false]);

  // Subscriptions that can no longer bill, a sandbox one, and another member's do not count.
  await subscription('SUBCANCELLED', MEMBER, 'live', 'CANCELLED');
  await subscription('SUBEXPIRED', MEMBER, 'live', 'EXPIRED');
  await subscription('SUBSANDBOX', MEMBER, 'sandbox', 'ACTIVE');
  await subscription('SUBOTHER', OTHER, 'live', 'ACTIVE');
  assert.deepEqual(await flags(member), [false, false, false, false]);
  assert.deepEqual(await flags(other), [false, false, false, true], 'the member with the live subscription can reach the page to cancel it');
  for (const state of ['ACTIVE', 'SUSPENDED', 'APPROVAL_PENDING']) {
    await fixture.db.update(paypalSubscriptions).set({ status: state }).where(eq(paypalSubscriptions.id, 'SUBOTHER'));
    assert.equal((await status(other)).showSupport, true, state);
  }
  await fixture.db.update(paypalSubscriptions).set({ status: 'CANCELLED' }).where(eq(paypalSubscriptions.id, 'SUBOTHER'));
  assert.equal((await status(other)).showSupport, false);

  // Each method on its own is enough.
  assert.equal((await toggle(admin, { enabled: true })).status, 200);
  assert.deepEqual(await flags(member), [false, false, true, true]);
  assert.equal((await toggle(admin, { enabled: false })).status, 200);

  await kofi.saveKofiConfiguration({ pageUrl: 'https://ko-fi.com/homelab', verificationToken: 'support-methods-kofi-token' }, ADMIN);
  await kofi.setKofiEnabled(true, ADMIN);
  assert.deepEqual(await flags(member), [false, true, false, true]);
  await kofi.setKofiEnabled(false, ADMIN);
  assert.deepEqual(await flags(member), [false, false, false, false]);

  await fixture.db.insert(paypalConfigs).values({ environment: 'sandbox', enabled: true });
  assert.deepEqual(await flags(member), [false, false, false, false], 'sandbox checkout is not member-facing');
  await fixture.db.insert(paypalConfigs).values({ environment: 'live', enabled: true });
  assert.deepEqual(await flags(member), [true, false, false, true]);
});
