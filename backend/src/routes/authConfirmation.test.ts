// Wrong confirmation credentials must not look like an expired session.
// Run with:  node --test src/routes/authConfirmation.test.ts   (from backend/)
//
// PUT /auth/change-password and POST /auth/reauthenticate used to answer 401
// when the supplied current password (or authenticator code) was wrong. The
// frontend's api.js interceptor treats any 401 on an authenticated page as a
// dead session and sends the browser to /login, so a single typo threw the user
// out of the portal instead of showing "current password is incorrect". These
// failures are now 403 + code CONFIRMATION_FAILED; 401 stays reserved for a
// caller with no session at all.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { generateSync } from 'otplib';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users } from '../db/schema/index.ts';

const PASSWORD = 'Correct-horse-battery-staple-1!';
const NEW_PASSWORD = 'Another-correct-horse-9!';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let encryptSecret: typeof import('../utils/secrets.ts').encryptSecret;
let userId: number;
let signedIn = true;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ encryptSecret } = await import('../utils/secrets.ts'));

  const [created] = await testDb.db
    .insert(users)
    .values({ username: 'confirm-user', password: bcrypt.hashSync(PASSWORD, 10) })
    .returning({ id: users.id });
  userId = created.id;

  const router = (await import('./auth.ts')).default;
  app = express();
  app.use(express.json());
  app.use(session({ secret: 'confirmation-test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (signedIn) {
      req.session.userId = userId;
      req.session.username = 'confirm-user';
      req.session.isAdmin = false;
    }
    next();
  });
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

async function resetUser(fields: Partial<{ totp_enabled: boolean; totp_secret: string | null }> = {}) {
  await testDb.db
    .update(users)
    .set({ password: bcrypt.hashSync(PASSWORD, 10), totp_enabled: false, totp_secret: null, ...fields })
    .where(eq(users.id, userId));
}

test('a wrong current password on change-password is a 403, not a session expiry', async () => {
  signedIn = true;
  await resetUser();
  const res = await request(app)
    .put('/change-password')
    .send({ currentPassword: 'not-the-password', newPassword: NEW_PASSWORD });

  assert.equal(res.status, 403, 'a 401 here makes the SPA redirect a perfectly valid session to /login');
  assert.equal(res.body.code, 'CONFIRMATION_FAILED');
  assert.equal(res.body.error, 'Current password is incorrect');

  const [row] = await testDb.db.select({ password: users.password }).from(users).where(eq(users.id, userId)).limit(1);
  assert.equal(bcrypt.compareSync(PASSWORD, row.password), true, 'the rejected request must not have changed the password');
});

test('the correct current password still changes the password', async () => {
  signedIn = true;
  await resetUser();
  const res = await request(app)
    .put('/change-password')
    .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const [row] = await testDb.db.select({ password: users.password }).from(users).where(eq(users.id, userId)).limit(1);
  assert.equal(bcrypt.compareSync(NEW_PASSWORD, row.password), true);
});

test('a wrong password on reauthenticate is a 403, not a session expiry', async () => {
  signedIn = true;
  await resetUser();
  const res = await request(app).post('/reauthenticate').send({ password: 'not-the-password' });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CONFIRMATION_FAILED');
  assert.equal(res.body.error, 'Password confirmation failed');
});

test('a wrong second factor on reauthenticate is a 403, not a session expiry', async () => {
  signedIn = true;
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await resetUser({ totp_enabled: true, totp_secret: encryptSecret(secret) });
  const res = await request(app).post('/reauthenticate').send({ password: PASSWORD, code: '000000' });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CONFIRMATION_FAILED');
  assert.equal(res.body.error, 'Second-factor confirmation failed');
});

test('correct confirmation credentials still stamp the reauthentication window', async () => {
  signedIn = true;
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await resetUser({ totp_enabled: true, totp_secret: encryptSecret(secret) });
  const res = await request(app).post('/reauthenticate').send({ password: PASSWORD, code: generateSync({ secret }) });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.validForSeconds, 900);
});

test('a caller with no session still gets 401 from both routes', async () => {
  signedIn = false;
  try {
    const changed = await request(app)
      .put('/change-password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(changed.status, 401, 'a genuinely signed-out caller must still be redirected to /login');
    assert.equal(changed.body.code, undefined);

    const reauth = await request(app).post('/reauthenticate').send({ password: PASSWORD });
    assert.equal(reauth.status, 401);
    assert.equal(reauth.body.code, undefined);
  } finally {
    signedIn = true;
  }
});
