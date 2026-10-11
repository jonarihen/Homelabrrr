import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { eloverblikConnections, users } from '../db/schema/index.ts';
import { FIXTURE_METER } from '../testUtils/eloverblikFixtures.ts';

// No route may reach the network in this suite.
globalThis.fetch = (async () => { throw new Error('unexpected network access'); }) as typeof fetch;
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
process.env.SECRET_ENCRYPTION_KEY = '67'.repeat(32);
const { default: energyDataRoutes } = await import('./energyData.ts');
const { csrfProtection } = await import('../middleware/requestSecurity.ts');
const { encryptSecret } = await import('../utils/secrets.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

const ORIGIN = 'https://portal.example';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.get('x-test-role');
  if (role) req.session = { userId: 1, username: role, isAdmin: role === 'admin',
    reauthenticatedAt: req.get('x-test-reauth') === 'yes' ? Date.now() : undefined } as typeof req.session;
  if (req.get('x-test-api-token') === 'yes') req.apiToken = { id: 1 } as typeof req.apiToken;
  next();
});
app.use(csrfProtection({ allowedOrigin: ORIGIN }));
app.use('/api/admin/energy-data', energyDataRoutes);
const base = '/api/admin/energy-data';

test.before(async () => {
  await fixture.db.insert(users).values({ id: 1, username: 'energy-data-admin', password: 'unused' });
  await fixture.db.insert(eloverblikConnections).values({ id: 1, refresh_token: encryptSecret('fixture-refresh-token'), enabled: true, selected_meter_id: FIXTURE_METER,
    last_attempt_at: new Date(), attention_code: 'RECONNECT_REQUIRED' });
});

test('energy-data routes are administrator, browser-session and same-origin only', async () => {
  for (const path of ['/status', '/meters']) {
    assert.equal((await request(app).get(base + path)).status, 401, path);
    assert.equal((await request(app).get(base + path).set('x-test-role', 'member')).status, 403, path);
    assert.equal((await request(app).get(base + path).set('x-test-role', 'admin').set('x-test-api-token', 'yes')).status, 403, path);
  }
  for (const path of ['/connection', '/meter', '/sync', '/disconnect']) {
    assert.equal((await request(app).post(base + path).set('Origin', ORIGIN)).status, 401, path);
    assert.equal((await request(app).post(base + path).set('x-test-role', 'member').set('Origin', ORIGIN)).status, 403, path);
    assert.equal((await request(app).post(base + path).set('x-test-role', 'admin').set('x-test-api-token', 'yes')).status, 403, path);
    const crossSite = await request(app).post(base + path).set('x-test-role', 'admin').set('x-test-reauth', 'yes').set('Origin', 'https://evil.example');
    assert.equal(crossSite.body.code, 'ORIGIN_NOT_ALLOWED', path);
  }
  for (const path of ['/connection', '/meter', '/disconnect']) {
    const stale = await request(app).post(base + path).set('x-test-role', 'admin').set('Origin', ORIGIN).send({});
    assert.equal(stale.body.code, 'REAUTHENTICATION_REQUIRED', path);
  }
});

test('status masks the meter and never exposes the credential', async () => {
  const response = await request(app).get(`${base}/status`).set('x-test-role', 'admin');
  assert.equal(response.status, 200);
  assert.equal(response.body.selectedMeter, '••••0001');
  assert.equal(response.body.attention.code, 'RECONNECT_REQUIRED');
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(`${FIXTURE_METER}|fixture-refresh-token|refresh_token|enc:v`));
});

test('manual sync validates the period, honours the cooldown and reports a paused connection', async () => {
  const admin = () => request(app).post(`${base}/sync`).set('x-test-role', 'admin').set('Origin', ORIGIN);
  assert.equal((await admin().send({ from: '2026-10-01' })).body.error, 'INVALID_PERIOD');
  assert.equal((await admin().send({ from: '2026-10-01', to: '2026-12-01' })).body.error, 'INVALID_PERIOD');
  const cooling = await admin().send({});
  assert.equal(cooling.status, 429);
  assert.ok(Number(cooling.headers['retry-after']) > 0);
  await fixture.db.update(eloverblikConnections).set({ last_attempt_at: new Date(Date.now() - 3_600_000) });
  const paused = await admin().send({});
  assert.equal(paused.status, 409);
  assert.equal(paused.body.error, 'RECONNECT_REQUIRED');
  assert.equal((await request(app).post(`${base}/disconnect`).set('x-test-role', 'admin').set('x-test-reauth', 'yes').set('Origin', ORIGIN).send({ purgeHistory: 'yes' })).body.error, 'INVALID_REQUEST');
});
