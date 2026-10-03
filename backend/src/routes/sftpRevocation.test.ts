import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import ssh2 from 'ssh2';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { roles, rolePermissions, sessions, sshKeys, users, vmAssignments, vmSshConfigs } from '../db/schema/index.ts';
import { requestContext } from '../utils/logger.ts';

process.env.SECRET_ENCRYPTION_KEY = '55'.repeat(32);
const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;
const { default: sftpRouter, sftpSessions } = await import('./sftp.ts');
const { default: authRouter } = await import('./auth.ts');
const { default: adminRouter } = await import('./admin.ts');
const { DrizzleSessionStore } = await import('../db/sessionStore.ts');
const { encryptSecret } = await import('../utils/secrets.ts');
const { closeDb } = await import('../db/client.ts');
const store = new DrizzleSessionStore();

const USER_ID = 7;
const ADMIN_ID = 8;
const SID = 'portal-session';
const OTHER_SID = 'other-portal-session';
const TOKEN = 'sftp-revocation-token';
const NODE = '1~pve1';
const VMID = 101;
const hostKey = ssh2.utils.generateKeyPairSync('ed25519');
const clientKey = ssh2.utils.generateKeyPairSync('ed25519');
const hostFingerprint = `SHA256:${createHash('sha256')
  .update(Buffer.from(String(hostKey.public).split(' ')[1], 'base64')).digest('base64')}`;
let connections = 0;
let uploadedBytes = 0;
const clients = new Set();
const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
  connections += 1;
  clients.add(client);
  client.on('close', () => clients.delete(client));
  client.on('error', () => {});
  client.on('authentication', (ctx) => ctx.accept());
  client.on('ready', () => client.on('session', (accept) => {
    accept().on('sftp', (accept) => {
      const sftp = accept();
      for (const event of ['REALPATH', 'OPENDIR']) {
        sftp.on(event, (id) => sftp.status(id, ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE));
      }
      sftp.on('OPEN', (id) => sftp.handle(id, Buffer.from('handle')));
      sftp.on('WRITE', (id, _handle, _offset, data) => {
        uploadedBytes += data.length;
        sftp.status(id, ssh2.utils.sftp.STATUS_CODE.OK);
      });
      sftp.on('CLOSE', (id) => sftp.status(id, ssh2.utils.sftp.STATUS_CODE.OK));
    });
  }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as { port: number };

function app(sessionId = SID, userId = USER_ID, isAdmin = false) {
  const instance = express();
  instance.use(requestContext, express.json());
  instance.use((req, _res, next) => {
    req.sessionID = sessionId;
    req.session = {
      userId, username: 'operator', isAdmin, reauthenticatedAt: Date.now(),
      destroy: (cb) => store.destroy(sessionId, cb),
    };
    next();
  });
  instance.use('/api/sftp', sftpRouter);
  instance.use('/api/auth', authRouter);
  instance.use('/api/admin', adminRouter);
  return instance;
}

function seedToken(token = TOKEN, sessionId = SID, userId = USER_ID) {
  const sess = {
    userId, sessionId, node: NODE, vmid: VMID, host: '127.0.0.1', port,
    username: 'tester', hostFingerprint, privateKey: clientKey.private, passphrase: '',
    expires: Date.now() + 30 * 60 * 1000,
    absoluteExpires: Date.now() + 8 * 60 * 60 * 1000,
  };
  sftpSessions.set(token, sess);
  return sess;
}

const operations = [
  ['ls', (instance) => request(instance).post('/api/sftp/ls').send({ token: TOKEN, path: '/' })],
  ['download', (instance) => request(instance).get('/api/sftp/download').query({ token: TOKEN, path: '/x' })],
  ['mkdir', (instance) => request(instance).post('/api/sftp/mkdir').send({ token: TOKEN, path: '/x' })],
  ['delete', (instance) => request(instance).post('/api/sftp/delete').send({ token: TOKEN, path: '/x' })],
  ['rename', (instance) => request(instance).post('/api/sftp/rename').send({ token: TOKEN, path: '/x', name: 'y' })],
  ['upload', (instance) => request(instance).post('/api/sftp/upload')
    .field('token', TOKEN).field('path', '/').attach('file', Buffer.from('denied'), 'x.txt')],
] as const;

test.beforeEach(async () => {
  sftpSessions.clear();
  await testDb.db.delete(sessions);
  await testDb.db.delete(users);
  await testDb.db.delete(roles);
  await testDb.db.delete(vmSshConfigs);
  await testDb.db.insert(users).values([
    { id: USER_ID, username: 'operator', password: 'unused' },
    { id: ADMIN_ID, username: 'admin', password: 'unused', is_admin: true },
  ]);
  await testDb.db.insert(sessions).values([SID, OTHER_SID].map((sid) => ({
    sid, sess: { userId: USER_ID }, expire: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })));
  await testDb.db.insert(vmAssignments).values({ user_id: USER_ID, node: 'pve1', vmid: VMID });
});

test.after(async () => {
  sftpSessions.clear();
  for (const client of clients) client.end();
  await new Promise<void>((resolve) => server.close(resolve));
  await closeDb();
  await testDb.drop();
});

for (const [name, send] of operations) {
  test(`${name} rejects a different portal session without refreshing the token`, async () => {
    const sess = seedToken();
    const expires = sess.expires;
    const before = connections;
    const res = await send(app(OTHER_SID));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Access denied');
    assert.equal(res.body.code, undefined);
    assert.equal(sess.expires, expires);
    assert.equal(sftpSessions.get(TOKEN), sess);
    assert.equal(connections, before);
  });

  test(`${name} rejects a different user`, async () => {
    const sess = seedToken();
    const expires = sess.expires;
    const before = connections;
    const res = await send(app(SID, ADMIN_ID, true));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Access denied');
    assert.equal(res.body.code, undefined);
    assert.equal(sess.expires, expires);
    assert.equal(sftpSessions.get(TOKEN), sess);
    assert.equal(connections, before);
  });

  test(`${name} revokes the token after VM assignment removal`, async () => {
    seedToken();
    await testDb.db.delete(vmAssignments);
    const before = connections;
    const res = await send(app());
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Access denied');
    assert.equal(res.body.code, undefined);
    assert.equal(sftpSessions.has(TOKEN), false);
    assert.equal(connections, before);
    await testDb.db.insert(vmAssignments).values({ user_id: USER_ID, node: NODE, vmid: VMID });
    const expired = await send(app());
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, 'SFTP_SESSION_EXPIRED');
  });

  test(`${name} rejects idle and absolute expiry before SSH`, async () => {
    const before = connections;
    for (const expiry of ['expires', 'absoluteExpires']) {
      seedToken()[expiry] = Date.now();
      const res = await send(app());
      assert.equal(res.status, 410);
      assert.equal(res.body.code, 'SFTP_SESSION_EXPIRED');
      assert.equal(sftpSessions.has(TOKEN), false);
    }
    assert.equal(connections, before);
  });
}

test('authorized operations honor legacy node assignments and cap idle renewal at absolute expiry', async () => {
  const sess = seedToken();
  sess.absoluteExpires = Date.now() + 60_000;
  const before = connections;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await request(app()).post('/api/sftp/ls').send({ token: TOKEN, path: '/' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'SFTP_PATH_NOT_FOUND');
    assert.equal(sess.expires, sess.absoluteExpires);
  }
  assert.equal(connections, before + 2);
});

test('authorized multipart uploads pass the session and VM authorization gate', async () => {
  seedToken();
  const before = connections;
  uploadedBytes = 0;
  const res = await request(app()).post('/api/sftp/upload')
    .field('token', TOKEN).field('path', '/').attach('file', Buffer.from('allowed'), 'x.txt');
  assert.equal(res.status, 200);
  assert.equal(res.body.size, 7);
  assert.equal(uploadedBytes, 7);
  assert.equal(connections, before + 1);
});

test('connect requires a portal session ID', async () => {
  const res = await request(app('')).post('/api/sftp/connect').send({ node: NODE, vmid: VMID, keyId: 1 });
  assert.equal(res.status, 403);
  assert.equal(sftpSessions.size, 0);
});

test('SFTP cannot mint or use session-bound tokens through API-token authentication', async () => {
  seedToken();
  const instance = express();
  instance.use(express.json(), (req, _res, next) => {
    req.apiToken = { id: 1 };
    req.session = { userId: USER_ID, username: 'operator', isAdmin: false };
    next();
  });
  instance.use('/api/sftp', sftpRouter);
  const before = connections;
  assert.equal((await request(instance).post('/api/sftp/connect').send({ node: NODE, vmid: VMID, keyId: 1 })).status, 403);
  for (const [, send] of operations) assert.equal((await send(instance)).status, 403);
  assert.equal(connections, before);
  assert.equal(sftpSessions.size, 1);
});

test('connect mints a portal-bound token with a 30-minute idle and eight-hour absolute lifetime', async () => {
  await testDb.db.update(users).set({ is_admin: true }).where(eq(users.id, USER_ID));
  const [key] = await testDb.db.insert(sshKeys).values({ user_id: USER_ID, name: 'test', private_key: encryptSecret(clientKey.private) }).returning();
  await testDb.db.insert(vmSshConfigs).values({ node: NODE, vmid: VMID, host: '127.0.0.1', port, host_fingerprint: hostFingerprint });
  const before = Date.now();
  const res = await request(app(SID, USER_ID, true)).post('/api/sftp/connect').send({ node: NODE, vmid: VMID, keyId: key.id });
  assert.equal(res.status, 200);
  const sess = sftpSessions.get(res.body.token);
  assert.ok(sess);
  assert.equal(sess.sessionId, SID);
  assert.equal(sess.userId, USER_ID);
  assert.ok(sess.expires >= before + 30 * 60 * 1000);
  assert.ok(sess.absoluteExpires <= Date.now() + 8 * 60 * 60 * 1000);
  assert.equal(sess.absoluteExpires - sess.expires, (8 * 60 - 30) * 60 * 1000);
});

test('live fleet permission removal revokes an unassigned token', async () => {
  await testDb.db.delete(vmAssignments);
  await testDb.db.update(users).set({ can_operate_all_vms: true }).where(eq(users.id, USER_ID));
  seedToken();
  assert.equal((await request(app()).post('/api/sftp/ls').send({ token: TOKEN })).status, 404);
  await testDb.db.update(users).set({ can_operate_all_vms: false, see_all_vms: true }).where(eq(users.id, USER_ID));
  assert.equal((await request(app()).post('/api/sftp/ls').send({ token: TOKEN })).status, 403);
  assert.equal(sftpSessions.has(TOKEN), false);
});

test('live role permission removal revokes an unassigned token', async () => {
  await testDb.db.delete(vmAssignments);
  const [role] = await testDb.db.insert(roles).values({ name: 'operator-role' }).returning();
  await testDb.db.insert(rolePermissions).values({ role_id: role.id, permission: 'can_operate_all_vms' });
  await testDb.db.update(users).set({ role_id: role.id }).where(eq(users.id, USER_ID));
  seedToken();
  assert.equal((await request(app()).post('/api/sftp/ls').send({ token: TOKEN })).status, 404);
  await testDb.db.delete(rolePermissions).where(eq(rolePermissions.role_id, role.id));
  assert.equal((await request(app()).post('/api/sftp/ls').send({ token: TOKEN })).status, 403);
  assert.equal(sftpSessions.has(TOKEN), false);
});

test('a stale session admin flag cannot bypass live admin demotion', async () => {
  seedToken();
  await testDb.db.delete(vmAssignments);
  assert.equal((await request(app(SID, USER_ID, true)).post('/api/sftp/ls').send({ token: TOKEN })).status, 403);
  assert.equal(sftpSessions.has(TOKEN), false);
});

test('missing, expired, mismatched, or enrollment-only stored portal sessions revoke tokens', async () => {
  const before = connections;
  for (const update of [
    () => testDb.db.delete(sessions).where(eq(sessions.sid, SID)),
    () => testDb.db.insert(sessions).values({ sid: SID, sess: { userId: USER_ID }, expire: new Date(0) }),
    () => testDb.db.update(sessions).set({ expire: new Date(Date.now() + 60_000), sess: { userId: ADMIN_ID } }).where(eq(sessions.sid, SID)),
    () => testDb.db.update(sessions).set({ sess: { userId: USER_ID, twoFactorEnrollmentOnly: true } }).where(eq(sessions.sid, SID)),
  ]) {
    seedToken();
    await update();
    const res = await request(app()).post('/api/sftp/ls').send({ token: TOKEN });
    assert.equal(res.status, 410);
    assert.equal(res.body.code, 'SFTP_SESSION_EXPIRED');
    assert.equal(sftpSessions.has(TOKEN), false);
  }
  assert.equal(connections, before);
});

test('logout destroys only tokens belonging to the current portal session', async () => {
  seedToken();
  seedToken('other-token', OTHER_SID);
  assert.equal((await request(app()).post('/api/auth/logout')).status, 200);
  assert.equal(sftpSessions.has(TOKEN), false);
  assert.equal(sftpSessions.has('other-token'), true);
  const expired = await request(app(OTHER_SID)).post('/api/sftp/ls').send({ token: TOKEN });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, 'SFTP_SESSION_EXPIRED');
});

test('single session revocation removes its SFTP tokens and preserves the current session', async () => {
  seedToken();
  seedToken('other-token', OTHER_SID);
  const res = await request(app(OTHER_SID)).delete(`/api/auth/sessions/${SID}`);
  assert.equal(res.status, 200);
  assert.equal(sftpSessions.has(TOKEN), false);
  assert.equal(sftpSessions.has('other-token'), true);
});

test('revoke-all-other sessions removes only the affected SFTP tokens', async () => {
  seedToken();
  seedToken('other-token', OTHER_SID);
  seedToken('admin-token', 'admin-session', ADMIN_ID);
  const res = await request(app(OTHER_SID)).delete('/api/auth/sessions');
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, 1);
  assert.equal(sftpSessions.has(TOKEN), false);
  assert.equal(sftpSessions.has('other-token'), true);
  assert.equal(sftpSessions.has('admin-token'), true);
});

test('admin user deletion immediately revokes all of that user’s SFTP tokens', async () => {
  await testDb.db.delete(vmAssignments);
  seedToken();
  seedToken('other-token', OTHER_SID);
  seedToken('admin-token', 'admin-session', ADMIN_ID);
  const res = await request(app('admin-session', ADMIN_ID, true)).delete(`/api/admin/users/${USER_ID}`);
  assert.equal(res.status, 200);
  assert.equal(sftpSessions.has(TOKEN), false);
  assert.equal(sftpSessions.has('other-token'), false);
  assert.equal(sftpSessions.has('admin-token'), true);
});

test('a deleted live user revokes even a token carrying a stale admin session', async () => {
  seedToken();
  seedToken('other-token', OTHER_SID);
  await testDb.db.delete(users).where(eq(users.id, USER_ID));
  const res = await request(app(SID, USER_ID, true)).post('/api/sftp/ls').send({ token: TOKEN });
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'SFTP_SESSION_EXPIRED');
  assert.equal(sftpSessions.has(TOKEN), false);
  assert.equal(sftpSessions.has('other-token'), false);
});
