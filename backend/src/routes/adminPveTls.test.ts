// Admin PVE host certificate pinning and Test connection (#275).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import express from 'express';
import request from 'supertest';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { auditLog, pveHosts, users } from '../db/schema/index.ts';
import { fixtureA, fixtureB } from '../services/iloPinning.fixtures.ts';

const pinA = new X509Certificate(fixtureA.cert).fingerprint256;
const pinB = new X509Certificate(fixtureB.cert).fingerprint256;
let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let app: express.Express;
let server: https.Server;
let port = 0;
let hostId: number;
let delegateId: number;
let memberId: number;
const seen: (string | undefined)[] = [];

before(async () => {
  server = https.createServer({ key: fixtureA.key, cert: fixtureA.cert }, (req, res) => {
    seen.push(req.headers.authorization);
    const ok = req.headers.authorization === 'PVEAPIToken=root@pam!t=sekret';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(ok ? '{"data":{"version":"8.2.4"}}' : '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  delete process.env.ALLOW_INSECURE_UPSTREAM_TLS;
  ({ closeDb } = await import('../db/client.ts'));
  const { encryptSecret } = await import('../utils/secrets.ts');
  [{ id: delegateId }] = await testDb.db.insert(users).values({ username: 'hosts-delegate', password: 'x', can_manage_hosts: true }).returning({ id: users.id });
  [{ id: memberId }] = await testDb.db.insert(users).values({ username: 'member', password: 'x' }).returning({ id: users.id });
  [{ id: hostId }] = await testDb.db.insert(pveHosts).values({
    name: 'pve', host: '127.0.0.1', port, token_id: 'root@pam!t', token_secret: encryptSecret('sekret'), verify_tls: true,
  }).returning({ id: pveHosts.id });

  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header('x-test-user') === 'member' ? memberId : delegateId;
    req.session = { userId, isAdmin: false, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const body = (over = {}) => ({ name: 'pve', host: '127.0.0.1', port, tokenId: 'root@pam!t', tokenSecret: '', ...over });
const readHost = async () => (await testDb.db.select().from(pveHosts).where(eq(pveHosts.id, hostId)))[0];

test('certificate probe and test connection need can_manage_hosts', async () => {
  for (const path of ['/pve-hosts/certificate-probe', '/pve-hosts/test']) {
    const res = await request(app).post(path).set('x-test-user', 'member').send(body({ tokenSecret: 'sekret' }));
    assert.equal(res.status, 403, path);
  }
});

test('certificate probe reads the self-signed certificate without sending credentials', async () => {
  seen.length = 0;
  const res = await request(app).post('/pve-hosts/certificate-probe').send({ host: '127.0.0.1', port });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.fingerprint256, pinA);
  assert.equal(res.body.selfSigned, true);
  assert.equal(seen.length, 0, 'no HTTP request, so no Authorization header');
});

test('test connection tries unsaved settings and categorizes the result', async () => {
  const ok = await request(app).post('/pve-hosts/test').send(body({ tokenSecret: 'sekret', verifyTls: false, tlsFingerprint: pinA }));
  assert.deepEqual(ok.body, { ok: true, version: '8.2.4' });
  const untrusted = await request(app).post('/pve-hosts/test').send(body({ tokenSecret: 'sekret', verifyTls: true }));
  assert.equal(untrusted.body.category, 'tls_untrusted');
  const mismatch = await request(app).post('/pve-hosts/test').send(body({ tokenSecret: 'sekret', tlsFingerprint: pinB }));
  assert.equal(mismatch.body.category, 'fingerprint_mismatch');
  const auth = await request(app).post('/pve-hosts/test').send(body({ tokenSecret: 'nope', tlsFingerprint: pinA }));
  assert.equal(auth.body.category, 'auth_failed');
  // Stored secret only for the unchanged target and trust.
  const reuse = await request(app).post('/pve-hosts/test').send(body({ id: hostId, verifyTls: true }));
  assert.equal(reuse.body.category, 'tls_untrusted');
  const retarget = await request(app).post('/pve-hosts/test').send(body({ id: hostId, tlsFingerprint: pinA }));
  assert.equal(retarget.status, 400);
  assert.equal(retarget.body.field, 'tokenSecret');
  assert.equal((await readHost()).tls_fingerprint, null, 'nothing persisted');
});

test('changing the pin requires the token secret and is audited', async () => {
  const blank = await request(app).put(`/pve-hosts/${hostId}`).send(body({ tlsFingerprint: pinA }));
  assert.equal(blank.status, 400);
  assert.equal(blank.body.field, 'tokenSecret');
  assert.equal((await request(app).put(`/pve-hosts/${hostId}`).send(body({ tokenSecret: 'sekret', tlsFingerprint: 'AB:CD' }))).status, 400);

  const set = await request(app).put(`/pve-hosts/${hostId}`).send(body({ tokenSecret: 'sekret', verifyTls: false, tlsFingerprint: pinA.toLowerCase() }));
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await readHost()).tls_fingerprint, pinA);
  // Unrelated edit with a blank secret keeps the pin.
  assert.equal((await request(app).put(`/pve-hosts/${hostId}`).send(body({ name: 'renamed', verifyTls: false }))).status, 200);
  assert.equal((await readHost()).tls_fingerprint, pinA);
  assert.equal((await request(app).put(`/pve-hosts/${hostId}`).send(body({ verifyTls: false, tlsFingerprint: null }))).status, 400, 'clearing the pin is a trust change');

  const [audit] = await testDb.db.select().from(auditLog).where(and(eq(auditLog.action, 'pve_host_tls_pin_changed'), eq(auditLog.target, String(hostId))));
  assert.match(audit.detail || '', new RegExp(`from=none; to=${pinA}`));
  assert.equal(JSON.stringify(audit).includes('sekret'), false);
});

test('a new host may be pinned instead of verified, without the break-glass flag', async () => {
  const res = await request(app).post('/pve-hosts').send(body({ name: 'pinned', tokenSecret: 'sekret', verifyTls: false, tlsFingerprint: pinA }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [row] = await testDb.db.select().from(pveHosts).where(eq(pveHosts.id, res.body.id));
  assert.equal(row.tls_fingerprint, pinA);
  assert.equal((await request(app).post('/pve-hosts').send(body({ name: 'insecure', tokenSecret: 'sekret', verifyTls: false }))).status, 400);
});
