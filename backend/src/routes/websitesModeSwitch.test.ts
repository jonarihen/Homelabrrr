// PUT /servers/:id: leaving Caddyfile mode must first empty the Homelabrrr
// snippet, or snippet routes (no managed @id) outlive the switch (#330).
// Run with:  node --test src/routes/websitesModeSwitch.test.ts   (from backend/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { caddyServers } from '../db/schema/index.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;

const readServer = async (id: number) => (await testDb.db.select().from(caddyServers).where(eq(caddyServers.id, id)))[0];

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '88'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));

  const router = (await import('./websites.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 1, username: 'operator', isAdmin: true, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('clearing sshHost is refused when the snippet cannot be emptied', async () => {
  const { encryptSecret } = await import('../utils/secrets.ts');
  // Port 1 on loopback refuses the SSH connection immediately.
  const [{ id }] = await testDb.db.insert(caddyServers).values({
    name: 'caddy-snippet', api_url: 'http://127.0.0.1:1', ssh_host: '127.0.0.1', ssh_port: 1, ssh_user: 'caddy',
    ssh_secret: encryptSecret('not-a-real-key'),
  }).returning({ id: caddyServers.id });

  const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /left in Caddyfile mode/);
  const row = await readServer(id);
  assert.equal(row.ssh_host, '127.0.0.1');
});

test('a server without a stored SSH credential switches to API mode directly', async () => {
  const [{ id }] = await testDb.db.insert(caddyServers).values({
    name: 'caddy-never-deployed', api_url: 'http://127.0.0.1:1', ssh_host: '127.0.0.1', ssh_port: 1, ssh_user: 'caddy',
  }).returning({ id: caddyServers.id });

  const res = await request(app).put(`/servers/${id}`).send({ sshHost: '' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await readServer(id)).ssh_host, '');
});
