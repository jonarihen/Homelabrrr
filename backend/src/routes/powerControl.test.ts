import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, hardwarePowerPolicies, pveHosts } from '../db/schema/index.ts';
import { weekdayPreset, type PowerPricePolicy } from '../services/powerPolicy.ts';

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

test('saved-policy preview is admin-only, bounded to valid instants, and read-only', async () => {
  const path = '/api/admin/power-control/1/preview';
  assert.equal((await request(app).get(path)).status, 401);
  assert.equal((await request(app).get(path).set('x-test-role', 'member')).status, 403);
  assert.equal((await request(app).get(`${path}?at=invalid`).set('x-test-role', 'admin')).status, 400);
  assert.equal((await request(app).get(path).set('x-test-role', 'admin')).status, 404);
});

test('saved-policy preview returns seven-day boundaries without enabling control', async () => {
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'preview', host: 'pve.test', token_id: 'test', token_secret: 'encrypted' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id,
    node_ref: `${host.id}~node`, target_host: 'ilo.test', username: 'reader', secret: 'encrypted',
    capabilities: { runtimeMode: 'supported', supportedModes: ['low', 'dynamic', 'high'] },
  }).returning();
  const schedule = weekdayPreset(); schedule.enabled = true;
  const pricePolicy: PowerPricePolicy = { enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', version: 1,
    expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
    cheap: { enabled: false, threshold: '', hysteresis: '' } };
  await fixture.db.insert(hardwarePowerPolicies).values({ hardware_id: hardware.id,
    schedule, price_policy: pricePolicy, automation_enabled: true, last_verified_mode: 'low' });
  const response = await request(app).get(`/api/admin/power-control/${hardware.id}/preview?at=2026-10-12T13:59:00Z`)
    .set('x-test-role', 'admin');
  assert.equal(response.status, 200);
  assert.equal(response.body.sevenDayPreview.nextScheduleTransition, '2026-10-12T14:00:00.000Z');
  assert.equal(response.body.sevenDayPreview.segments[0].baseMode, 'low');
  assert.equal(response.body.sevenDayPreview.segments[1].baseMode, 'high');
  assert.equal(response.body.sevenDayPreview.segments[1].selectedMode, null);
  assert.equal(response.body.nextKnownTransition, null);
});
