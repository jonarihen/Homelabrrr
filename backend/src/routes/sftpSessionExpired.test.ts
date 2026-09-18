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
  await testDb.drop();
});

function app() {
  const instance = express();
  instance.use(requestContext, express.json());
  instance.use((req, _res, next) => {
    req.session = { userId: USER_ID, username: 'operator', isAdmin: false };
    next();
  });
  instance.use('/api/sftp', sftpRouter);
  return instance;
}

test('a stale SFTP token is a 403 with a code, not a session expiry', async () => {
  const cases = [
    () => request(app()).post('/api/sftp/ls').send({ token: 'missing-token', path: '/' }),
    () => request(app()).get('/api/sftp/download').query({ token: 'missing-token', path: '/x' }),
    () => request(app()).post('/api/sftp/mkdir').send({ token: 'missing-token', path: '/x' }),
    () => request(app()).post('/api/sftp/delete').send({ token: 'missing-token', path: '/x' }),
    () => request(app()).post('/api/sftp/rename').send({ token: 'missing-token', path: '/x', name: 'y' }),
  ];
  for (const send of cases) {
    const res = await send();
    assert.equal(res.status, 403, 'a 401 here makes the SPA redirect a perfectly valid session to /login');
    assert.equal(res.body.code, 'SFTP_SESSION_EXPIRED');
    assert.equal(res.body.error, 'SFTP session expired or invalid');
  }
  assert.equal(sftpSessions.has('missing-token'), false);
});
