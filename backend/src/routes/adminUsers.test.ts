// GET /api/admin/users returns three correlated aggregates per user.
// Run with:  node --test src/routes/adminUsers.test.ts   (from backend/)
//
// PostgreSQL COUNT()/MAX(COUNT()) are bigint, and pg hands bigint back as a
// string. Drizzle's `sql<number>` is only a type assertion, so without an
// explicit mapWith(Number) these came out of the migration as JSON strings
// where SQLite had returned numbers. Assert the JSON types, not just the
// values — `assert.equal('3', 3)` would have passed straight over the bug.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, vmAssignments, loginAttempts } from '../db/schema/index.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const [admin] = await testDb.db
    .insert(users)
    .values({ username: 'aggregate-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });

  // Two VM assignments, so vm_count is a number worth reading.
  await testDb.db.insert(vmAssignments).values([
    { user_id: admin.id, node: '1~pve', vmid: 101 },
    { user_id: admin.id, node: '1~pve', vmid: 102 },
  ]);
  // Three recent failures from one address, so recent_failures and
  // max_ip_failures are both non-zero.
  const now = Date.now();
  await testDb.db.insert(loginAttempts).values([
    { username: 'aggregate-admin', ip: '10.0.0.9', attempted_at: now },
    { username: 'aggregate-admin', ip: '10.0.0.9', attempted_at: now },
    { username: 'aggregate-admin', ip: '10.0.0.9', attempted_at: now },
  ]);

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: admin.id, username: 'aggregate-admin', isAdmin: true } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('per-user aggregates are JSON numbers, not bigint strings', async () => {
  const res = await request(app).get('/users');
  assert.equal(res.status, 200);

  const user = res.body.find((u: { username: string }) => u.username === 'aggregate-admin');
  assert.ok(user, 'the seeded user should be listed');

  for (const field of ['vm_count', 'recent_failures', 'max_ip_failures'] as const) {
    assert.equal(
      typeof user[field], 'number',
      `${field} must be a number in the API response, got ${typeof user[field]} (${JSON.stringify(user[field])})`,
    );
  }

  assert.equal(user.vm_count, 2);
  assert.equal(user.recent_failures, 3);
  assert.equal(user.max_ip_failures, 3);
});

test('a user with no VMs and no failures reports zeroes, still as numbers', async () => {
  await testDb.db.insert(users).values({ username: 'aggregate-quiet', password: 'x' });

  const res = await request(app).get('/users');
  const quiet = res.body.find((u: { username: string }) => u.username === 'aggregate-quiet');
  assert.ok(quiet, 'the quiet user should be listed');

  assert.equal(typeof quiet.vm_count, 'number');
  assert.equal(quiet.vm_count, 0);
  assert.equal(typeof quiet.max_ip_failures, 'number');
  assert.equal(quiet.max_ip_failures, 0);
  // The lockout verdict is derived from max_ip_failures — it must stay false here.
  assert.equal(quiet.locked, false);
});
