import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users } from '../db/schema/index.ts';

const NEW_PASSWORD = 'Another-correct-horse-9!';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let ghostUserId = 0;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '77'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const router = (await import('./auth.ts')).default;
  app = express();
  app.use(express.json());
  app.use(session({ secret: 'deleted-user-test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = ghostUserId;
    req.session.username = 'deleted-ghost';
    req.session.isAdmin = false;
    req.session.reauthenticatedAt = Date.now();
    next();
  });
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('account routes answer 401 instead of crashing for a deleted-user session', async () => {
  const [created] = await testDb.db
    .insert(users)
    .values({ username: 'soon-deleted', password: 'x' })
    .returning({ id: users.id });
  ghostUserId = created.id;
  await testDb.db.delete(users).where(eq(users.id, created.id));

  const changed = await request(app)
    .put('/change-password')
    .send({ currentPassword: 'whatever', newPassword: NEW_PASSWORD });
  assert.equal(changed.status, 401);

  const setup = await request(app).post('/2fa/setup').send({});
  assert.equal(setup.status, 401);

  const options = await request(app).post('/passkeys/register/options').send({});
  assert.equal(options.status, 401);

  ghostUserId = 0;
});
