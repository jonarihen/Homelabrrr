import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';

process.env.SECRET_ENCRYPTION_KEY = '55'.repeat(32);
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { default: powerControlRoutes } = await import('./powerControl.ts');
test.after(() => fixture.drop());

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.get('x-test-role');
  if (role) req.session = {
    userId: 1, username: role, isAdmin: role === 'admin',
    reauthenticatedAt: req.get('x-test-reauth') === 'yes' ? Date.now() : undefined,
  } as typeof req.session;
  if (req.get('x-test-api-token') === 'yes') req.apiToken = {} as typeof req.apiToken;
  next();
});
app.use('/api/admin/power-control', powerControlRoutes);

test('power policy and global automation state stay private and admin-only', async () => {
  const path = '/api/admin/power-control/global';
  assert.equal((await request(app).get(path)).status, 401);
  assert.equal((await request(app).get(path).set('x-test-role', 'member')).status, 403);
  const admin = await request(app).get(path).set('x-test-role', 'admin');
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body, { paused: false });
});

test('live automation changes require interactive recent reauthentication', async () => {
  const path = '/api/admin/power-control/global/pause';
  const unauthenticated = await request(app).post(path).send({ paused: true });
  assert.equal(unauthenticated.status, 401);
  const member = await request(app).post(path).set('x-test-role', 'member').send({ paused: true });
  assert.equal(member.status, 403);
  const stale = await request(app).post(path).set('x-test-role', 'admin').send({ paused: true });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'REAUTHENTICATION_REQUIRED');
  const apiToken = await request(app).post(path).set('x-test-role', 'admin').set('x-test-api-token', 'yes').send({ paused: true });
  assert.equal(apiToken.status, 403);
  const malformed = await request(app).post(path).set('x-test-role', 'admin').set('x-test-reauth', 'yes').send({ paused: 'yes' });
  assert.equal(malformed.status, 400);
});

test('manual control endpoint rejects missing acknowledgement context and bad input', async () => {
  const manual = await request(app).post('/api/admin/power-control/1/manual')
    .set('x-test-role', 'admin').set('x-test-reauth', 'yes').send({ version: 1, mode: 'os_control', durationMinutes: 60 });
  assert.equal(manual.status, 400);
  const enable = await request(app).post('/api/admin/power-control/1/enable')
    .set('x-test-role', 'admin').set('x-test-reauth', 'yes').send({});
  assert.equal(enable.status, 400);
});
