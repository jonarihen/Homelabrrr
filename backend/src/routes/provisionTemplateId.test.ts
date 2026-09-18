import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '99'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const router = (await import('./provision.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 1, username: 'admin', isAdmin: true };
    next();
  });
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('non-numeric template ids answer 404 instead of crashing', async () => {
  const updated = await request(app).put('/admin/templates/abc').send({ name: 'x' });
  assert.equal(updated.status, 404, `expected 404, got ${updated.status}: ${JSON.stringify(updated.body)}`);

  const deleted = await request(app).delete('/admin/templates/abc');
  assert.equal(deleted.status, 404, `expected 404, got ${deleted.status}: ${JSON.stringify(deleted.body)}`);
});
