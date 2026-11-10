import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, firewalls, vlans } from '../db/schema/index.ts';

// A non-admin VLAN manager only sees the VLANs assigned to them, so the create
// form cannot work out the next free tag by itself. GET /vlans/next-tag must
// answer with the tag POST /vlans will really allocate.

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
const ids: Record<string, number> = {};

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  const rows = await testDb.db.insert(users).values([
    { username: 'tag-admin', password: 'x', is_admin: true },
    { username: 'tag-manager', password: 'x', can_manage_vlans: true },
    { username: 'tag-outsider', password: 'x' },
  ]).returning({ id: users.id, username: users.username });
  for (const row of rows) ids[row.username] = row.id;
  await testDb.db.insert(firewalls).values({ name: 'fw-pool', host: '192.168.100.1', api_key: 'k', vdom: 'lab', verify_tls: false,
    vlan_range_start: 1001, vlan_range_end: 1004 });
  // Tags taken by VLANs the manager is not assigned to, and therefore cannot see.
  await testDb.db.insert(vlans).values([{ name: 'theirs-a', tag: 1001, mode: 'managed' }, { name: 'theirs-b', tag: 1002, mode: 'managed' }]);

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const username = String(req.headers['x-test-user'] || '');
    req.session = { userId: ids[username], username, isAdmin: username === 'tag-admin', reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

const as = (username: string) => ({
  get: (path: string) => request(app).get(path).set('x-test-user', username),
  post: (path: string, body: object) => request(app).post(path).set('x-test-user', username).send(body),
});

test('the previewed tag is the one a non-admin is really given, counting VLANs they cannot see', async () => {
  const manager = as('tag-manager');
  assert.deepEqual((await manager.get('/vlans')).body, []);
  assert.deepEqual((await manager.get('/vlans/next-tag')).body, { tag: 1003 });
  const created = await manager.post('/vlans', { name: 'mine' });
  assert.equal(created.status, 200);
  assert.equal(created.body.tag, 1003);
  assert.deepEqual((await manager.get('/vlans/next-tag')).body, { tag: 1004 });
});

test('an exhausted pool answers null, and the lookup needs VLAN management rights', async () => {
  await testDb.db.insert(vlans).values({ name: 'last', tag: 1004, mode: 'managed' });
  assert.deepEqual((await as('tag-manager').get('/vlans/next-tag')).body, { tag: null });
  assert.equal((await as('tag-outsider').get('/vlans/next-tag')).status, 403);
  assert.deepEqual((await as('tag-admin').get('/vlans/next-tag')).body, { tag: null });
});
