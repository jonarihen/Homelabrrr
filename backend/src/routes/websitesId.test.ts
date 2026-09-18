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
  process.env.SECRET_ENCRYPTION_KEY ||= '88'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const router = (await import('./websites.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 1, username: 'operator', isAdmin: true };
    next();
  });
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('non-numeric website ids answer 404 instead of crashing', async () => {
  for (const send of [
    () => request(app).get('/sites/abc'),
    () => request(app).get('/servers/abc/status'),
    () => request(app).put('/servers/abc').send({}),
    () => request(app).delete('/servers/abc'),
    () => request(app).post('/admin/sites/abc/assign').send({}),
    () => request(app).delete('/admin/sites/abc'),
  ]) {
    const res = await send();
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
});
