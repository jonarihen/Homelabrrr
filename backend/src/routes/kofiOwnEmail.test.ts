import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import signature from 'cookie-signature';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { auditLog, kofiMemberEmails, paypalWebhookInbox, users } from '../db/schema/index.ts';
import { kofiEvent } from '../testUtils/kofiFixtures.ts';

// A member's own Ko-fi email binding, on the real session, CSRF and payments
// router stack. Throwaway PostgreSQL, no network.
process.env.SECRET_ENCRYPTION_KEY = '5c'.repeat(32);
process.env.ALLOWED_ORIGIN = 'https://portal.example';
const SECRET = 'kofi-own-email-session-secret';
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
const kofiAdmin = await import('../services/kofiAdmin.ts');

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
let member = ''; let other = '';

const mine = async (cookie: string) => (await request(app).get('/api/payments/mine').set('Cookie', cookie)).body.kofiEmails;
const add = (cookie: string, email: unknown) => request(app).post('/api/payments/kofi-emails').set('Cookie', cookie).set(ORIGIN).send({ email } as object);
const remove = (cookie: string, id: unknown) => request(app).delete(`/api/payments/kofi-emails/${String(id)}`).set('Cookie', cookie).set(ORIGIN);

test.before(async () => {
  await fixture.db.insert(users).values([
    { id: MEMBER, username: 'member-kofi', password: 'unused' }, { id: ADMIN, username: 'admin-kofi', password: 'unused', is_admin: true },
    { id: OTHER, username: 'other-kofi', password: 'unused' },
  ]);
  member = await login('sid-member', { userId: MEMBER });
  other = await login('sid-other', { userId: OTHER });
});

test('adding is refused while Ko-fi is switched off', async () => {
  const res = await add(member, 'anders@example.dk');
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'KOFI_DISABLED' });
  assert.deepEqual(await mine(member), []);
});

test('a member binds their own email, unverified', async () => {
  await kofi.saveKofiConfiguration({ pageUrl: 'https://ko-fi.com/homelab', verificationToken: 'kofi-own-email-token' }, ADMIN);
  await kofi.setKofiEnabled(true, ADMIN);
  assert.equal((await add(member, 'not-an-email')).body.error, 'INVALID_EMAIL');
  const res = await add(member, '  Anders@Example.DK ');
  assert.equal(res.status, 201);
  assert.equal(res.body.items.length, 1);
  const [item] = res.body.items;
  assert.equal(item.removable, true);
  // Only a masked hint ever leaves the server, and the address is not stored.
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('anders@example.dk'));
  const [row] = await fixture.db.select().from(kofiMemberEmails).where(eq(kofiMemberEmails.id, item.id));
  assert.deepEqual([row.user_id, row.source, row.verified_by], [MEMBER, 'member_entry', null]);
  assert.ok(!JSON.stringify(row).toLowerCase().includes('anders@example.dk'));
  assert.equal(item.verified, false);
  assert.deepEqual(await mine(member), res.body.items);
  assert.deepEqual(await mine(other), []);
  const audit = await fixture.db.select().from(auditLog).where(eq(auditLog.action, 'kofi.member_email.self_add'));
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).toLowerCase().includes('example.dk'));
});

test('a member-entered email matches no payment until the owner verifies it by linking one', async () => {
  const email = kofi.normalizeKofiEmail('anders@example.dk');
  // Anyone can type any address, so the claim alone must not attribute another payer's receipts.
  assert.equal(await kofi.matchKofiMember(fixture.db as any, email), null);
  const event = kofiEvent({ email: 'Anders@example.dk', verification_token: 'kofi-own-email-token' });
  assert.deepEqual(await kofi.storeKofiWebhook(JSON.stringify(event)), { stored: true });
  await kofi.processKofiInbox();
  const id = `live:kofi:${String(event.message_id)}`;
  const [held] = await fixture.db.select().from(paypalWebhookInbox).where(eq(paypalWebhookInbox.id, id));
  assert.deepEqual([held.status, held.error_code], ['needs_review', 'MEMBER_UNMATCHED']);
  const review = (await kofiAdmin.listKofiReviewEvents()).items.find((item) => item.id === id)!;
  assert.deepEqual([review.matchedUserId, review.matchedVerified], [MEMBER, false]);
  await kofiAdmin.linkKofiReviewEvent(id, { userId: MEMBER }, ADMIN);
  assert.equal((await kofi.matchKofiMember(fixture.db as any, email))?.userId, MEMBER);
  const [row] = await fixture.db.select().from(kofiMemberEmails).where(eq(kofiMemberEmails.user_id, MEMBER));
  assert.deepEqual([row.source, row.verified_by], ['member_verified', ADMIN]);
  const [own] = await mine(member);
  assert.deepEqual([own.removable, own.verified], [true, true]);
});

test('an address someone already holds cannot be claimed, by them or by another member', async () => {
  assert.deepEqual([(await add(other, 'anders@example.dk')).status, (await add(other, 'ANDERS@example.dk')).body.error], [409, 'EMAIL_ALREADY_LINKED']);
  assert.equal((await add(member, 'anders@example.dk')).body.error, 'EMAIL_ALREADY_LINKED');
  assert.deepEqual(await mine(other), []);
});

test('each member is capped, and owner-made links do not count toward the cap', async () => {
  await kofiAdmin.addKofiMemberEmail({ userId: MEMBER, email: 'owner-linked@example.dk' }, ADMIN);
  assert.equal((await add(member, 'second@example.dk')).status, 201);
  assert.equal((await add(member, 'third@example.dk')).status, 201);
  const refused = await add(member, 'fourth@example.dk');
  assert.deepEqual([refused.status, refused.body.error], [409, 'TOO_MANY_EMAILS']);
  assert.equal((await mine(member)).length, 4);
});

test('a member removes only rows they entered themselves', async () => {
  const items = await mine(member);
  const ownerLinked = items.find((item: any) => !item.removable);
  const own = items.find((item: any) => item.removable);
  assert.ok(ownerLinked && own);
  assert.equal((await remove(member, ownerLinked.id)).status, 404);
  assert.equal((await remove(other, own.id)).status, 404);
  assert.equal((await remove(member, 'abc')).status, 400);
  const res = await remove(member, own.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 3);
  assert.ok(!res.body.items.some((item: any) => item.id === own.id));
  // Removing still works with Ko-fi off, and the freed slot can be used again once it is on.
  await kofi.setKofiEnabled(false, ADMIN);
  const another = (await mine(member)).find((item: any) => item.removable);
  assert.equal((await remove(member, another.id)).status, 200);
  await kofi.setKofiEnabled(true, ADMIN);
  assert.equal((await add(member, 'fourth@example.dk')).status, 201);
});

test('requests without the portal origin are refused', async () => {
  const res = await request(app).post('/api/payments/kofi-emails').set('Cookie', member).send({ email: 'x@example.dk' });
  assert.equal(res.status, 403);
});
