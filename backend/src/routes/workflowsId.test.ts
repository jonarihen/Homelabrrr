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
  process.env.SECRET_ENCRYPTION_KEY ||= 'aa'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const router = (await import('./workflows.ts')).default;
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

test('non-numeric workflow ids answer 404 instead of crashing', async () => {
  for (const [name, send, notFound] of [
    ['runs-list', () => request(app).get('/runs').query({ firewallId: 'abc' }), null],
    ['run', () => request(app).get('/runs/abc'), 'Run not found'],
    ['workflow', () => request(app).get('/abc'), 'Workflow not found'],
    ['update', () => request(app).put('/abc').send({}), 'Workflow not found'],
    ['steps', () => request(app).put('/abc/steps').send({ steps: [] }), 'Workflow not found'],
    ['reset', () => request(app).post('/abc/reset').send({}), 'Workflow not found'],
    ['dry-run', () => request(app).post('/abc/dry-run').send({}), 'Workflow not found'],
    ['by-firewall', () => request(app).get('/').query({ firewallId: 'abc' }), 'Firewall not found'],
  ] as const) {
    const res = await send();
    if (notFound === null) {
      assert.equal(res.status, 200, `${name}: expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, []);
    } else {
      assert.equal(res.status, 404, `${name}: expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, notFound);
    }
  }
});
