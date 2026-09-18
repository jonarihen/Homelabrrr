import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { invites, users } from '../db/schema/index.ts';

let hashInviteToken: typeof import('../utils/invites.ts').hashInviteToken;

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ hashInviteToken } = await import('../utils/invites.ts'));
  const router = (await import('./auth.ts')).default;
  app = express();
  app.use(express.json());
  app.use(session({ secret: 'invite-test-session-secret', resave: false, saveUninitialized: false }));
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('concurrent redemption creates exactly one account and rejects the loser', async () => {
  const token = 'concurrent-invite';
  const [invite] = await testDb.db.insert(invites).values({
    token_hash: hashInviteToken(token),
    require_2fa: true,
    preset: { permissions: { can_provision: true }, maxCores: 4 },
  }).returning();
  const blocker = await testDb.pool.connect();
  const usernames = ['invite-racer-one', 'invite-racer-two'];
  let pending: Promise<request.Response>[] = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM invites WHERE id = $1 FOR UPDATE', [invite.id]);
    pending = usernames.map((username) => request(app)
      .post(`/invite/${token}`)
      .send({ username, password: 'Strong-invite-password-123!' })
      .then((res) => res));
    const deadline = Date.now() + 10000;
    let waiting = 0;
    while (Date.now() < deadline) {
      const result = await testDb.pool.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%invites%'",
      );
      waiting = result.rows[0].waiting;
      if (waiting === 2) break;
      await setTimeout(20);
    }
    assert.equal(waiting, 2, 'both redemptions must overlap while waiting on the invite row');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await Promise.allSettled(pending);
  }
  const responses = await Promise.all(pending);
  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 410]);
  const winner = responses.find((res) => res.status === 200)!;
  const loser = responses.find((res) => res.status === 410)!;
  assert.equal(loser.body.error, 'This invite has already been used.');
  assert.equal(winner.body.twoFactorSetupRequired, true);
  assert.equal(winner.body.canProvision, true);
  const accounts = await testDb.db.select().from(users).where(inArray(users.username, usernames));
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, winner.body.id);
  assert.equal(accounts[0].max_cores, 4);
  const [consumed] = await testDb.db.select().from(invites).where(eq(invites.id, invite.id));
  assert.equal(consumed.used_by, accounts[0].id);
  assert.equal(consumed.used_by_username, accounts[0].username);
  assert.ok(consumed.used_at);
});

test('failed account creation rolls back and leaves the invite redeemable', async () => {
  const token = 'retryable-invite';
  await testDb.db.insert(users).values({ username: 'invite-existing', password: 'unused' });
  const [invite] = await testDb.db.insert(invites).values({ token_hash: hashInviteToken(token) }).returning();
  const rejected = await request(app).post(`/invite/${token}`)
    .send({ username: 'invite-existing', password: 'Strong-invite-password-123!' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'Username already exists');
  const [unchanged] = await testDb.db.select().from(invites).where(eq(invites.id, invite.id));
  assert.equal(unchanged.used_at, null);
  assert.equal(unchanged.used_by, null);
  const accepted = await request(app).post(`/invite/${token}`)
    .send({ username: 'invite-retry', password: 'Strong-invite-password-123!' });
  assert.equal(accepted.status, 200);
  const [consumed] = await testDb.db.select().from(invites).where(eq(invites.id, invite.id));
  assert.equal(consumed.used_by, accepted.body.id);
});
