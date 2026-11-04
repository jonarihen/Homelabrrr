// Run with:  node --test src/routes/recoveryCodes.test.ts   (from backend/)
// Recovery-code login: single use, shares the 2FA lockout budget, issued at enrollment.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { generateSync } from 'otplib';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, recoveryCodes } from '../db/schema/index.ts';

const PASSWORD = 'Correct-horse-battery-staple-1!';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let userId: number;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  const { encryptSecret } = await import('../utils/secrets.ts');
  const [u] = await testDb.db.insert(users).values({
    username: 'rc-user', password: bcrypt.hashSync(PASSWORD, 10), totp_enabled: true, totp_secret: encryptSecret(SECRET),
  }).returning({ id: users.id });
  userId = u.id;
  const router = (await import('./auth.ts')).default;
  app = express();
  app.use(express.json());
  app.use(session({ secret: 's', resave: false, saveUninitialized: false }));
  app.use('/', router);
});

after(async () => { await closeDb?.(); await testDb?.drop(); });

async function pendingAgent() {
  const agent = request.agent(app);
  const res = await agent.post('/login').send({ username: 'rc-user', password: PASSWORD });
  assert.equal(res.body.requiresTwoFactor, true);
  return agent;
}

test('a backup code logs in once, then is rejected', async () => {
  const { hashRecoveryCode } = await import('../utils/accountSecurity.ts');
  await testDb.db.delete(recoveryCodes);
  await testDb.db.insert(recoveryCodes).values({ user_id: userId, code_hash: hashRecoveryCode('AAAA-BBBB-CCCC-DDDD') });
  const first = await (await pendingAgent()).post('/verify-recovery-code').send({ code: 'AAAA-BBBB-CCCC-DDDD' });
  assert.equal(first.status, 200);
  const second = await (await pendingAgent()).post('/verify-recovery-code').send({ code: 'AAAA-BBBB-CCCC-DDDD' });
  assert.equal(second.status, 401);
});

test('wrong backup codes lock out the account, TOTP included', async () => {
  const { db } = await import('../db/client.ts');
  await db.delete((await import('../db/schema/index.ts')).twoFactorAttempts);
  const agent = await pendingAgent();
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await agent.post('/verify-recovery-code').send({ code: 'WRONG' })).status;
  assert.equal(last, 423);
  const again = await (await pendingAgent()).post('/verify-2fa').send({ code: generateSync({ secret: SECRET }) });
  assert.equal(again.status, 423);
});

test('enabling 2FA returns hashed-only backup codes', async () => {
  await testDb.db.delete(recoveryCodes);
  await testDb.db.update(users).set({ totp_enabled: false }).where(eq(users.id, userId));
  const authed = express();
  authed.use(express.json());
  authed.use(session({ secret: 's', resave: false, saveUninitialized: false }));
  authed.use((req, _res, next) => { Object.assign(req.session, { userId, username: 'rc-user', isAdmin: false, reauthenticatedAt: Date.now() }); next(); });
  authed.use('/', (await import('./auth.ts')).default);
  const res = await request(authed).post('/2fa/enable').send({ code: generateSync({ secret: SECRET }) });
  assert.equal(res.status, 200);
  assert.equal(res.body.recoveryCodes.length, 10);
  const rows = await testDb.db.select().from(recoveryCodes);
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => !res.body.recoveryCodes.includes(r.code_hash)));
});
