import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, hardwarePowerPolicies, pveHosts } from '../db/schema/index.ts';
import { weekdayPreset, type PowerPricePolicy } from '../services/powerPolicy.ts';
import { eq } from 'drizzle-orm';

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

test('invalid manual duration is rejected before changing a policy or contacting iLO', async () => {
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'manual', host: 'pve-manual.test', token_id: 'test', token_secret: 'encrypted' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id,
    node_ref: `${host.id}~node`, target_host: 'ilo-manual.test', username: 'reader', secret: 'encrypted', control_enabled: true,
    capabilities: { runtimeMode: 'supported', supportedModes: ['low', 'dynamic', 'high'] },
  }).returning();
  const schedule = weekdayPreset();
  const pricePolicy: PowerPricePolicy = { enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', version: 1,
    expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
    cheap: { enabled: false, threshold: '', hysteresis: '' } };
  await fixture.db.insert(hardwarePowerPolicies).values({ hardware_id: hardware.id, schedule, price_policy: pricePolicy });
  const response = await request(app).post(`/api/admin/power-control/${hardware.id}/manual`)
    .set('x-test-role', 'admin').set('x-test-reauth', 'yes')
    .send({ version: 1, mode: 'high', durationKind: 'next_schedule_boundary' });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Enable a weekly schedule/);
  const [unchanged] = await fixture.db.select().from(hardwarePowerPolicies)
    .where(eq(hardwarePowerPolicies.hardware_id, hardware.id)).limit(1);
  assert.equal(unchanged.version, 1);
  assert.equal(unchanged.manual_mode, null);
});

// Routes with an injected read-only hardware fake (never real iLO).
let fakeState: { mode: 'low' | 'dynamic' | 'high' | 'os_control' | 'unknown'; powerState: 'on' | 'off' | 'booting' | 'unknown' } | Error = { mode: 'low', powerState: 'on' };
const { createPowerControlRouter } = await import('./powerControl.ts');
const { encryptSecret } = await import('../utils/secrets.ts');
app.use('/api/fake-power', createPowerControlRouter({ readState: async () => { if (fakeState instanceof Error) throw fakeState; return fakeState; } }));

const disabledPrice = (): PowerPricePolicy => ({ enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', version: 1,
  expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' },
  cheap: { enabled: false, threshold: '', hysteresis: '' } });

let routeNode = 0;
async function savedHardware(policy: Partial<typeof hardwarePowerPolicies.$inferInsert> | null = {}, supportedModes = ['low', 'dynamic', 'high']) {
  routeNode += 1;
  const [host] = await fixture.db.insert(pveHosts).values({ name: `route${routeNode}`, host: `pve-route${routeNode}.test`, token_id: 'test', token_secret: 'encrypted' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~node`,
    target_host: `ilo-route${routeNode}.test`, username: 'reader', secret: encryptSecret('fixture-only'), control_enabled: true,
    capabilities: { runtimeMode: 'supported', supportedModes } }).returning();
  if (policy) {
    const schedule = weekdayPreset(); schedule.enabled = true;
    await fixture.db.insert(hardwarePowerPolicies).values({ hardware_id: hardware.id, schedule, price_policy: disabledPrice(), automation_enabled: true, ...policy });
  }
  return hardware.id;
}

function body(overrides: Record<string, unknown> = {}) {
  const schedule = weekdayPreset(); schedule.enabled = true;
  return { version: 0, automationEnabled: true, schedule, pricePolicy: { ...disabledPrice(), enabled: true, contractRef: '12', area: 'DK2',
    expensive: { enabled: true, threshold: '3,00', hysteresis: '0,10', capMode: 'dynamic' },
    cheap: { enabled: true, threshold: '1,0', hysteresis: '0,1' }, version: 99 }, ...overrides };
}

test('policy save normalizes Danish decimals, owns revisions and rejects loose booleans', async () => {
  const id = await savedHardware(null);
  const put = (payload: unknown) => request(app).put(`/api/admin/power-control/${id}`).set('x-test-role', 'admin').send(payload);
  assert.equal((await put({ ...body(), automationEnabled: 'true' })).status, 400);
  const loose = body(); (loose.pricePolicy as any).cheap.enabled = 'yes';
  assert.equal((await put(loose)).status, 400);
  const injected = body(); (injected.pricePolicy as any).expensive.threshold = '3.1234567';
  assert.equal((await put(injected)).status, 400);
  const saved = await put({ ...body(), smuggled: true });
  assert.equal(saved.status, 200);
  const [row] = await fixture.db.select().from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id));
  assert.equal(row.price_policy.expensive.threshold, '3');
  assert.equal(row.price_policy.expensive.hysteresis, '0.1');
  assert.equal(row.price_policy.cheap.threshold, '1');
  assert.equal(row.price_policy.version, 1, 'client-sent version 99 is ignored');
  assert.equal(row.schedule.version, 1);
  assert.equal((row as any).smuggled, undefined);
  // An unchanged re-save keeps revisions; a threshold change bumps only the price revision.
  assert.equal((await put({ ...body(), version: 1 })).status, 200);
  const changed = body({ version: 2 }); (changed.pricePolicy as any).expensive.threshold = '3,50';
  assert.equal((await put(changed)).status, 200);
  const [after] = await fixture.db.select().from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id));
  assert.deepEqual([after.schedule.version, after.price_policy.version, after.version], [1, 2, 3]);
});

test('price-only automation needs an explicit default and modes must match capabilities', async () => {
  const id = await savedHardware(null, ['low', 'dynamic']);
  const priceOnly = body(); (priceOnly.schedule as any).enabled = false;
  const response = await request(app).put(`/api/admin/power-control/${id}`).set('x-test-role', 'admin').send(priceOnly);
  assert.equal(response.status, 400);
  assert.match(response.body.error, /price-only default/);
  const unsupported = await request(app).put(`/api/admin/power-control/${id}`).set('x-test-role', 'admin').send(body());
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.body.error, /Unsupported mode for this hardware: high/);
  const fresh = await request(app).get(`/api/admin/power-control/${id}`).set('x-test-role', 'admin');
  assert.equal(fresh.body.policy.pricePolicy.priceOnlyDefault, undefined, 'no pre-filled price-only default');
});

test('an expired claim from a crashed worker no longer blocks edits', async () => {
  const id = await savedHardware({ claim_token: 'dead', claim_expires_at: new Date(Date.now() - 60_000) });
  const response = await request(app).post(`/api/admin/power-control/${id}/pause`).set('x-test-role', 'admin').send({ paused: true, version: 1 });
  assert.equal(response.status, 200);
  const live = await savedHardware({ claim_token: 'alive', claim_expires_at: new Date(Date.now() + 60_000) });
  assert.equal((await request(app).post(`/api/admin/power-control/${live}/pause`).set('x-test-role', 'admin').send({ paused: true, version: 1 })).status, 409);
});

test('resume after drift adopts a fresh read and refuses OS Control or unreadable hosts', async () => {
  const id = await savedHardware({ drift_hold: true, last_verified_mode: 'high', version: 3 });
  const resume = () => request(app).post(`/api/fake-power/${id}/resume-drift`).set('x-test-role', 'admin');
  fakeState = new Error('unreachable');
  assert.equal((await resume().send({ version: 3 })).status, 503);
  fakeState = { mode: 'os_control', powerState: 'on' };
  assert.equal((await resume().send({ version: 3 })).status, 409);
  fakeState = { mode: 'dynamic', powerState: 'off' };
  assert.equal((await resume().send({ version: 3 })).status, 409);
  fakeState = { mode: 'dynamic', powerState: 'on' };
  const ok = await resume().send({ version: 3 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.adoptedMode, 'dynamic');
  const [row] = await fixture.db.select().from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id));
  assert.deepEqual([row.drift_hold, row.last_verified_mode, row.version], [false, 'dynamic', 4]);
});

test('preview matches the worker: a manual override under pause is reported as paused', async () => {
  const id = await savedHardware({ paused: true, manual_mode: 'high', manual_expires_at: new Date('2026-10-12T18:00:00Z'), last_verified_mode: 'low' });
  const response = await request(app).get(`/api/admin/power-control/${id}/preview?at=2026-10-12T16:00:00Z`).set('x-test-role', 'admin');
  assert.equal(response.status, 200);
  assert.equal(response.body.reason, 'paused');
  assert.equal(response.body.selectedMode, null);
  const disabled = await savedHardware({ automation_enabled: false, last_verified_mode: 'low' });
  const ifEnabled = await request(app).get(`/api/admin/power-control/${disabled}/preview?at=2026-10-12T16:00:00Z`).set('x-test-role', 'admin');
  assert.equal(ifEnabled.body.reason, 'disabled');
  assert.deepEqual(ifEnabled.body.ifEnabled, { selectedMode: 'high', reason: 'schedule', baseMode: 'high' });
  assert.ok(ifEnabled.body.ifEnabledPreview.segments.length > 1);
});

test('draft preview validates an unsaved policy without storing it', async () => {
  const id = await savedHardware({ last_verified_mode: 'low' });
  const draft = body({ at: '2026-10-12T16:00:00Z' });
  (draft.pricePolicy as any).enabled = false;
  const path = `/api/admin/power-control/${id}/preview`;
  assert.equal((await request(app).post(path).set('x-test-role', 'member').send(draft)).status, 403);
  const response = await request(app).post(path).set('x-test-role', 'admin').send(draft);
  assert.equal(response.status, 200);
  assert.equal(response.body.draft, true);
  assert.equal(response.body.selectedMode, 'high');
  const invalid = body(); (invalid.pricePolicy as any).cheap.threshold = '2,95';
  assert.equal((await request(app).post(path).set('x-test-role', 'admin').send(invalid)).status, 400);
  const [row] = await fixture.db.select().from(hardwarePowerPolicies).where(eq(hardwarePowerPolicies.hardware_id, id));
  assert.equal(row.version, 1);
});

test('operation history is admin-only', async () => {
  const id = await savedHardware();
  assert.equal((await request(app).get(`/api/admin/power-control/${id}/operations`).set('x-test-role', 'member')).status, 403);
  const response = await request(app).get(`/api/admin/power-control/${id}/operations`).set('x-test-role', 'admin');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.operations, []);
});
