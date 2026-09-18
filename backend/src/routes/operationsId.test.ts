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
  process.env.SECRET_ENCRYPTION_KEY ||= 'ab'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const router = (await import('./operations.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 1, username: 'admin', isAdmin: true, reauthenticatedAt: Date.now() };
    next();
  });
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('non-numeric operation ids answer 404 instead of crashing', async () => {
  for (const [name, send, notFound] of [
    ['prov-reconcile', () => request(app).post('/provision/abc/reconcile').send({}), 'Provisioning operation not found'],
    ['mig-reconcile', () => request(app).post('/migration/abc/reconcile').send({}), 'Migration operation not found'],
    ['mig-resolve', () => request(app).post('/migration/abc/resolve').send({ status: 'ok' }), 'Migration operation not found'],
    ['prov-resolve', () => request(app).post('/provision/abc/resolve').send({ status: 'ready' }), 'Provisioning operation not found'],
    ['prov-delete', () => request(app).delete('/provision/abc'), 'Provisioning operation not found'],
    ['mig-delete', () => request(app).delete('/migration/abc'), 'Migration operation not found'],
  ] as const) {
    const res = await send();
    assert.equal(res.status, 404, `${name}: expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, notFound);
  }
});
