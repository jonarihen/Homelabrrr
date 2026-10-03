import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { requestContext } from '../utils/logger.ts';

process.env.SECRET_ENCRYPTION_KEY = '66'.repeat(32);
import { createTestDatabase } from '../testUtils/pgTestDb.ts';

const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;
const { default: sftpRouter, sftpSessions } = await import('./sftp.ts');

const USER_ID = 11;

test.after(async () => {
  sftpSessions.clear();
  await testDb.drop();
});

function app(authenticated = true) {
  const instance = express();
  instance.use(requestContext, express.json());
  instance.use((req, _res, next) => {
    req.sessionID = 'test-session';
    req.session = authenticated ? { userId: USER_ID, username: 'operator', isAdmin: false } : {};
    next();
  });
  instance.use('/api/sftp', sftpRouter);
  return instance;
}

const operations = [
  { name: 'ls', send: (instance, token) => request(instance).post('/api/sftp/ls').send({ token, path: '/' }) },
  { name: 'download', send: (instance, token) => request(instance).get('/api/sftp/download').query({ ...(token === undefined ? {} : { token }), path: '/x' }) },
  { name: 'mkdir', send: (instance, token) => request(instance).post('/api/sftp/mkdir').send({ token, path: '/x' }) },
  { name: 'delete', send: (instance, token) => request(instance).post('/api/sftp/delete').send({ token, path: '/x' }) },
  { name: 'rename', send: (instance, token) => request(instance).post('/api/sftp/rename').send({ token, path: '/x', name: 'y' }) },
  {
    name: 'upload',
    send: (instance, token) => {
      const upload = request(instance).post('/api/sftp/upload');
      if (token !== undefined) upload.field('token', token);
      return upload.field('path', '/').attach('file', Buffer.from('contents'), 'x.txt');
    },
  },
];

for (const operation of operations) {
  for (const state of ['missing', 'empty', 'unknown', 'expired']) {
    test(`${operation.name} returns SFTP_SESSION_EXPIRED with 410 for a ${state} token`, async () => {
      const token = state === 'missing' ? undefined : state === 'empty' ? '' : `${operation.name}-${state}`;
      if (state === 'expired') {
        sftpSessions.set(token, { userId: USER_ID, sessionId: 'test-session', expires: Date.now() - 1 });
      }
      const res = await operation.send(app(), token);
      assert.equal(res.status, 410);
      assert.deepEqual(res.body, { code: 'SFTP_SESSION_EXPIRED', error: 'SFTP session expired or invalid' });
      assert.equal(sftpSessions.has(token), false);
      if (operation.name === 'upload') assert.equal(res.headers.connection, 'close');
    });
  }

  test(`${operation.name} still returns portal-auth 401 without a signed-in session`, async () => {
    const res = await operation.send(app(false), 'missing-token');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  });
}

test('connect still returns portal-auth 401 without a signed-in session', async () => {
  const res = await request(app(false)).post('/api/sftp/connect').send({ node: '1~pve', vmid: 101, keyId: 1 });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
});

test('an upload with its token after the file part returns the expiry response', async () => {
  const token = 'late-upload-token';
  sftpSessions.set(token, { userId: USER_ID, sessionId: 'test-session', expires: Date.now() + 60_000 });
  try {
    const res = await request(app()).post('/api/sftp/upload')
      .field('path', '/')
      .attach('file', Buffer.from('contents'), 'x.txt')
      .field('token', token);
    assert.equal(res.status, 410);
    assert.equal(res.body.code, 'SFTP_SESSION_EXPIRED');
    assert.equal(res.headers.connection, 'close');
  } finally {
    sftpSessions.delete(token);
  }
});

test('malformed uploads remain validation errors rather than session expiry', async () => {
  const res = await request(app()).post('/api/sftp/upload').send({ token: 'missing-token' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, undefined);
});
