// Credential changes revoke other sessions; signed-in confirmations are throttled;
// non-string credentials are a 400, not a 500.
// Run with:  node --test src/routes/authSessionHardening.test.ts   (from backend/)
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { generateSync } from 'otplib';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { sessions, twoFactorAttempts, users } from '../db/schema/index.ts';

const PASSWORD = 'Correct-horse-battery-staple-1!';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const EXPIRE = new Date(Date.now() + 60 * 60 * 1000);

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let encryptSecret: typeof import('../utils/secrets.ts').encryptSecret;
let userId: number;
let otherUserId: number;
let adminApp: express.Express;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ encryptSecret } = await import('../utils/secrets.ts'));

  const [created, other] = await testDb.db
    .insert(users)
    .values([
      { username: 'harden-user', password: bcrypt.hashSync(PASSWORD, 10) },
      { username: 'bystander', password: bcrypt.hashSync(PASSWORD, 10) },
    ])
    .returning({ id: users.id });
  userId = created.id;
  otherUserId = other.id;

  const router = (await import('./auth.ts')).default;
  app = express();
  app.use(express.json());
  app.use(session({ secret: 'hardening-test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (req.path !== '/login' && !req.get('x-anonymous')) {
      req.session.userId = userId;
      req.session.username = 'harden-user';
      req.session.isAdmin = false;
      req.session.reauthenticatedAt = Date.now();
    }
    next();
  });
  app.use('/', router);

  const [admin] = await testDb.db
    .insert(users)
    .values({ username: 'harden-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });
  const adminRouter = (await import('./admin.ts')).default;
  adminApp = express();
  adminApp.use(express.json());
  adminApp.use(session({ secret: 'hardening-test-secret', resave: false, saveUninitialized: false }));
  adminApp.use((req, _res, next) => {
    req.session.userId = admin.id;
    req.session.username = 'harden-admin';
    req.session.isAdmin = true;
    req.session.reauthenticatedAt = Date.now();
    next();
  });
  adminApp.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

beforeEach(async () => {
  await testDb.db.delete(sessions);
  await testDb.db.delete(twoFactorAttempts);
  await testDb.db.insert(sessions).values([
    { sid: 'mine-elsewhere', sess: { userId }, expire: EXPIRE },
    { sid: 'theirs', sess: { userId: otherUserId }, expire: EXPIRE },
  ]);
  await testDb.db
    .update(users)
    .set({ password: bcrypt.hashSync(PASSWORD, 10), totp_enabled: false, totp_secret: null })
    .where(eq(users.id, userId));
});

async function remainingSids() {
  return (await testDb.db.select({ sid: sessions.sid }).from(sessions)).map((r) => r.sid).sort();
}

test('changing the password revokes the user\'s other sessions only', async () => {
  const res = await request(app)
    .put('/change-password')
    .send({ currentPassword: PASSWORD, newPassword: 'Another-correct-horse-9!' });
  assert.equal(res.status, 200);
  assert.equal(res.body.revokedSessions, 1);
  assert.deepEqual(await remainingSids(), ['theirs']);
});

test('a revoked session is not resurrected by an in-flight save', async () => {
  const { DrizzleSessionStore } = await import('../db/sessionStore.ts');
  const store = new DrizzleSessionStore();
  const sid = 'in-flight-elsewhere';
  const sess = { userId, cookie: { maxAge: 60_000 } } as any;
  await new Promise<void>((resolve, reject) => store.set(sid, sess, (err) => (err ? reject(err) : resolve())));

  const res = await request(app)
    .put('/change-password')
    .send({ currentPassword: PASSWORD, newPassword: 'Another-correct-horse-9!' });
  assert.equal(res.status, 200);

  // The stolen session's request finishes after the revocation and saves.
  await new Promise<void>((resolve, reject) => store.set(sid, { ...sess, lastSeenAt: Date.now() }, (err) => (err ? reject(err) : resolve())));
  assert.deepEqual(await remainingSids(), ['theirs']);
  const loaded = await new Promise((resolve, reject) => store.get(sid, (err, s) => (err ? reject(err) : resolve(s))));
  assert.equal(loaded, null);
});

test('enabling 2FA revokes the user\'s other sessions', async () => {
  await testDb.db.update(users).set({ totp_secret: encryptSecret(SECRET) }).where(eq(users.id, userId));
  const res = await request(app).post('/2fa/enable').send({ code: generateSync({ secret: SECRET }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await remainingSids(), ['theirs']);
});

test('disabling 2FA revokes the user\'s other sessions', async () => {
  await testDb.db.update(users).set({ totp_enabled: true, totp_secret: encryptSecret(SECRET) }).where(eq(users.id, userId));
  const res = await request(app).post('/2fa/disable').send({ code: generateSync({ secret: SECRET }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await remainingSids(), ['theirs']);
});

test('reauthenticate locks out after repeated failures, even with the right password', async () => {
  for (let i = 0; i < 6; i++) {
    const res = await request(app).post('/reauthenticate').send({ password: 'wrong-guess' });
    assert.equal(res.status, 403);
  }
  const locked = await request(app).post('/reauthenticate').send({ password: PASSWORD });
  assert.equal(locked.status, 423);
  assert.equal(locked.body.code, 'CONFIRMATION_LOCKED');

  // The budget is shared, so the 2FA toggle cannot be used as a side channel.
  await testDb.db.update(users).set({ totp_enabled: true, totp_secret: encryptSecret(SECRET) }).where(eq(users.id, userId));
  const disable = await request(app).post('/2fa/disable').send({ code: generateSync({ secret: SECRET }) });
  assert.equal(disable.status, 423);
});

test('parallel reauthentication guesses cannot exceed the budget', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => request(app).post('/reauthenticate').send({ password: 'wrong-guess' })),
  );
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 403).length, 6, statuses.join(','));
  assert.equal(statuses.filter((s) => s === 423).length, 4, statuses.join(','));
});

test('unauthenticated hits from the same address do not exhaust a signed-in user\'s budget', async () => {
  for (let i = 0; i < 35; i++) {
    const res = await request(app).post('/reauthenticate').set('x-anonymous', '1').send({ password: 'wrong-guess' });
    assert.equal(res.status, 401);
  }
  const res = await request(app).post('/reauthenticate').send({ password: PASSWORD });
  assert.equal(res.status, 200);
});

test('a successful reauthentication clears the failure budget', async () => {
  for (let i = 0; i < 5; i++) await request(app).post('/reauthenticate').send({ password: 'wrong-guess' });
  assert.equal((await request(app).post('/reauthenticate').send({ password: PASSWORD })).status, 200);
  assert.equal((await request(app).post('/reauthenticate').send({ password: 'wrong-guess' })).status, 403);
});

test('non-string credentials are a 400, not a 500', async () => {
  for (const body of [{ username: 'harden-user', password: 1 }, { username: {}, password: PASSWORD }]) {
    const res = await request(app).post('/login').send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const res = await request(app).put('/change-password').send({ currentPassword: 1, newPassword: 'Another-correct-horse-9!' });
  assert.equal(res.status, 400);
});

test('admin password and 2FA resets revoke the target\'s sessions', async () => {
  const pw = await request(adminApp).put(`/users/${userId}/password`).send({ password: 'Admin-reset-horse-7!' });
  assert.equal(pw.status, 200);
  assert.deepEqual(await remainingSids(), ['theirs']);

  await testDb.db.insert(sessions).values({ sid: 'mine-again', sess: { userId }, expire: EXPIRE });
  await testDb.db.update(users).set({ totp_enabled: true, totp_secret: encryptSecret(SECRET) }).where(eq(users.id, userId));
  const totp = await request(adminApp).post(`/users/${userId}/reset-2fa`).send({});
  assert.equal(totp.status, 200);
  assert.deepEqual(await remainingSids(), ['theirs']);
});
