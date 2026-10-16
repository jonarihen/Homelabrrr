// PUT /api/admin/pve-hosts/:id and /firewalls/:id keep a stored secret on a
// blank field only while the upstream target is unchanged (#265).
// Run with:  node --test src/routes/adminSecretReentry.test.ts   (from backend/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, pveHosts, firewalls } from '../db/schema/index.ts';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let app: express.Express;
let hostId: number;
let fwId: number;
let nullHostId: number;
let nullFwId: number;

const pveBody = (over = {}) => ({ name: 'pve', host: 'pve.lab', port: 8006, tokenId: 'root@pam!t', tokenSecret: '', ...over });
const fwBody = (over = {}) => ({ name: 'fw', host: 'fw.lab', port: 443, apiKey: '', ...over });
const readHost = async () => (await testDb.db.select().from(pveHosts).where(eq(pveHosts.id, hostId)))[0];
const readFw = async () => (await testDb.db.select().from(firewalls).where(eq(firewalls.id, fwId)))[0];

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  // Lets the tests reach the TLS-downgrade branch; read once when admin.ts loads.
  process.env.ALLOW_INSECURE_UPSTREAM_TLS = 'true';
  ({ closeDb } = await import('../db/client.ts'));
  const [delegate] = await testDb.db.insert(users)
    .values({ username: 'hosts-delegate', password: 'x', can_manage_hosts: true, can_manage_firewalls: true })
    .returning({ id: users.id });
  [{ id: hostId }] = await testDb.db.insert(pveHosts).values({
    name: 'pve', host: 'pve.lab', port: 8006, token_id: 'root@pam!t', token_secret: 'enc-token',
    ssh_host: 'pve.lab', ssh_port: 22, ssh_secret: 'enc-ssh',
  }).returning({ id: pveHosts.id });
  [{ id: fwId }] = await testDb.db.insert(firewalls).values({ name: 'fw', host: 'fw.lab', port: 443, api_key: 'enc-key' })
    .returning({ id: firewalls.id });
  // Legacy rows with NULL verify_tls; the upstream clients treat NULL as verified.
  [{ id: nullHostId }] = await testDb.db.insert(pveHosts).values({
    name: 'pve', host: 'pve.lab', port: 8006, token_id: 'root@pam!t', token_secret: 'enc-token', verify_tls: null,
  }).returning({ id: pveHosts.id });
  [{ id: nullFwId }] = await testDb.db.insert(firewalls).values({ name: 'fw', host: 'fw.lab', port: 443, api_key: 'enc-key', verify_tls: null })
    .returning({ id: firewalls.id });

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: delegate.id, isAdmin: false, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('PVE host: blank token secret is refused when host, port or token ID change', async () => {
  for (const over of [{ host: 'evil.lab' }, { port: 8443 }, { tokenId: 'root@pam!other' }]) {
    const res = await request(app).put(`/pve-hosts/${hostId}`).send(pveBody(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.body.field, 'tokenSecret');
  }
  const row = await readHost();
  assert.equal(row.host, 'pve.lab');
  assert.equal(row.token_secret, 'enc-token');
});

test('PVE host: blank token secret keeps the stored one when the target is unchanged', async () => {
  const res = await request(app).put(`/pve-hosts/${hostId}`).send(pveBody({ name: 'renamed' }));
  assert.equal(res.status, 200);
  const row = await readHost();
  assert.equal(row.name, 'renamed');
  assert.equal(row.token_secret, 'enc-token');
});

test('PVE host: blank SSH secret is refused when the SSH address changes', async () => {
  for (const over of [{ sshHost: 'evil.lab', sshPort: 22 }, { sshHost: 'pve.lab', sshPort: 2222 }]) {
    const res = await request(app).put(`/pve-hosts/${hostId}`).send(pveBody({ ...over, sshSecret: '' }));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.body.field, 'sshSecret');
  }
  const ok = await request(app).put(`/pve-hosts/${hostId}`).send(pveBody({ sshHost: 'pve.lab', sshPort: 22, sshSecret: '' }));
  assert.equal(ok.status, 200);
  const row = await readHost();
  assert.equal(row.ssh_host, 'pve.lab');
  assert.equal(row.ssh_secret, 'enc-ssh');
});

test('PVE host: a re-entered secret allows changing the address', async () => {
  const res = await request(app).put(`/pve-hosts/${hostId}`).send(pveBody({ host: 'pve2.lab', tokenSecret: 'new-secret' }));
  assert.equal(res.status, 200);
  const row = await readHost();
  assert.equal(row.host, 'pve2.lab');
  assert.notEqual(row.token_secret, 'enc-token');
});

test('Firewall: blank API key is refused when host or port change, kept otherwise', async () => {
  for (const over of [{ host: 'evil.lab' }, { port: 8443 }]) {
    const res = await request(app).put(`/firewalls/${fwId}`).send(fwBody(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.body.field, 'apiKey');
  }
  assert.equal((await readFw()).host, 'fw.lab');

  const same = await request(app).put(`/firewalls/${fwId}`).send(fwBody({ name: 'fw-renamed' }));
  assert.equal(same.status, 200);
  assert.equal((await readFw()).api_key, 'enc-key');

  const moved = await request(app).put(`/firewalls/${fwId}`).send(fwBody({ host: 'fw2.lab', apiKey: 'new-key' }));
  assert.equal(moved.status, 200);
  const row = await readFw();
  assert.equal(row.host, 'fw2.lab');
  assert.notEqual(row.api_key, 'enc-key');
});

test('NULL verify_tls counts as verified: switching it off needs the secret again', async () => {
  const pve = await request(app).put(`/pve-hosts/${nullHostId}`).send(pveBody({ verifyTls: false }));
  assert.equal(pve.status, 400);
  assert.equal(pve.body.field, 'tokenSecret');
  const fw = await request(app).put(`/firewalls/${nullFwId}`).send(fwBody({ verifyTls: false }));
  assert.equal(fw.status, 400);
  assert.equal(fw.body.field, 'apiKey');

  // Omitting verifyTls keeps NULL rows verified and needs no secret.
  assert.equal((await request(app).put(`/pve-hosts/${nullHostId}`).send(pveBody())).status, 200);
  assert.equal((await request(app).put(`/firewalls/${nullFwId}`).send(fwBody())).status, 200);
  const [host] = await testDb.db.select().from(pveHosts).where(eq(pveHosts.id, nullHostId));
  const [fwRow] = await testDb.db.select().from(firewalls).where(eq(firewalls.id, nullFwId));
  assert.equal(host.verify_tls, true);
  assert.equal(fwRow.verify_tls, true);
  assert.equal(host.token_secret, 'enc-token');
  assert.equal(fwRow.api_key, 'enc-key');
});
