import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, hardwarePowerSamples, pveHosts, users } from '../db/schema/index.ts';
import type { HardwareDiscovery } from '../services/iloAdapter.ts';
import { IloError } from '../services/iloAdapter.ts';

let fixture: TestDatabase;
let app: express.Express;
let closeDb: () => Promise<void>;
let hostId: number;
let adminId: number;
let memberId: number;
let discovery: () => Promise<HardwareDiscovery>;

function found(uuid: string): HardwareDiscovery {
  return { identity: { uuid, serial: null }, model: 'DL380', generation: 'ilo5', firmware: 'fixture',
    mode: { value: 'dynamic', origin: '/redfish/v1/Systems/1#Oem.Hpe.PowerRegulatorMode' },
    capabilities: { monitoring: 'supported', runtimeMode: 'supported', writePrivilege: 'unverified' },
    sample: { watts: 250, origin: '/redfish/v1/Chassis/1/Power#PowerControl.PowerConsumedWatts', unit: 'W', observedAt: new Date().toISOString() } };
}

before(async () => {
  fixture = await createTestDatabase();
  process.env.DATABASE_URL = fixture.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'cluster', host: 'pve.example.test', token_id: 'test', token_secret: 'test' }).returning();
  hostId = host.id;
  const [admin] = await fixture.db.insert(users).values({ username: 'hardware-admin', password: 'x', is_admin: true }).returning();
  const [member] = await fixture.db.insert(users).values({ username: 'hardware-member', password: 'x', is_admin: false }).returning();
  adminId = admin.id;
  memberId = member.id;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.header('x-test-role');
    if (role) req.session = { userId: role === 'admin' ? adminId : memberId, isAdmin: role === 'admin' } as never;
    next();
  });
  app.use('/', (await import('./hardware.ts')).createHardwareRouter(async () => discovery()));
});

after(async () => { await closeDb?.(); await fixture?.drop(); });

test('hardware administration is denied to anonymous and ordinary members', async () => {
  assert.equal((await request(app).get('/')).status, 401);
  assert.equal((await request(app).get('/').set('x-test-role', 'member')).status, 403);
  assert.equal((await request(app).post('/').set('x-test-role', 'member').send({})).status, 403);
});

test('two physical nodes behind one PVE connection remain distinct and secrets stay private', async () => {
  for (const nodeName of ['pve-a', 'pve-b']) {
    const result = await request(app).post('/').set('x-test-role', 'admin').send({
      nodeRef: `${hostId}~${nodeName}`, host: `${nodeName}.mgmt.example.test`, port: 443,
      username: 'monitor', password: 'fixture-secret', verifyTls: true,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.node_ref, `${hostId}~${nodeName}`);
    assert.equal(result.body.has_secret, true);
    assert.equal(JSON.stringify(result.body).includes('fixture-secret'), false);
    assert.equal(result.body.secret, undefined);
  }
  const listing = await request(app).get('/').set('x-test-role', 'admin');
  assert.equal(listing.status, 200);
  assert.equal(listing.body.length, 2);
  assert.equal(JSON.stringify(listing.body).includes('fixture-secret'), false);
  const stored = await fixture.db.select().from(hardwareConnections);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((row) => row.secret.startsWith('enc:v2:')));
  const duplicate = await request(app).post('/').set('x-test-role', 'admin').send({ nodeRef: `${hostId}~pve-a`, host: 'other.example.test', username: 'monitor', password: 'fixture-secret' });
  assert.equal(duplicate.status, 409);
});

test('stale edits cannot overwrite a connection; edits preserve physical identity and disable automation', async () => {
  const [beforeRow] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-a`));
  await fixture.db.update(hardwareConnections).set({ system_uuid: 'fixture-uuid', collection_enabled: true, control_enabled: true }).where(eq(hardwareConnections.id, beforeRow.id));
  const stale = await request(app).put(`/${beforeRow.id}`).set('x-test-role', 'admin').send({ host: 'new.example.test', username: 'monitor', configVersion: beforeRow.config_version + 1 });
  assert.equal(stale.status, 409);
  const accepted = await request(app).put(`/${beforeRow.id}`).set('x-test-role', 'admin').send({ host: 'new.example.test', username: 'monitor', configVersion: beforeRow.config_version });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.system_uuid, 'fixture-uuid');
  assert.equal(accepted.body.collection_enabled, false);
  assert.equal(accepted.body.control_enabled, false);
  const [saved] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, beforeRow.id));
  assert.equal(saved.secret, beforeRow.secret, 'blank password keeps existing encrypted secret');
  assert.equal(saved.system_uuid, 'fixture-uuid');
});

test('connection test binds one physical identity and rejects a second node pointing to it', async () => {
  const [first] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-a`));
  const [second] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-b`));
  discovery = async () => found(' FIXTURE-UUID ');
  const same = await request(app).post(`/${first.id}/test`).set('x-test-role', 'admin');
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.connection.system_uuid, 'fixture-uuid');
  assert.equal(same.body.connection.secret, undefined);
  const duplicate = await request(app).post(`/${second.id}/test`).set('x-test-role', 'admin');
  assert.equal(duplicate.status, 409);
  const [saved] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, second.id));
  assert.equal(saved.system_uuid, null);
});

test('changed physical identity disables control and cannot rewrite the historical identity', async () => {
  const [row] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-a`));
  await fixture.db.update(hardwareConnections).set({ collection_enabled: true, control_enabled: true }).where(eq(hardwareConnections.id, row.id));
  discovery = async () => found('DIFFERENT-SERVER');
  const result = await request(app).post(`/${row.id}/test`).set('x-test-role', 'admin');
  assert.equal(result.status, 409);
  const [saved] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, row.id));
  assert.equal(saved.system_uuid, 'fixture-uuid');
  assert.equal(saved.collection_enabled, false);
  assert.equal(saved.control_enabled, false);
  assert.equal(saved.last_status, 'identity_changed');
});

test('in-flight connection test cannot overwrite a credential edit', async () => {
  const [row] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-b`));
  let release!: (result: HardwareDiscovery) => void;
  discovery = () => new Promise((resolve) => { release = resolve; });
  const testing = request(app).post(`/${row.id}/test`).set('x-test-role', 'admin');
  const pending = testing.then((response) => response);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const edit = await request(app).put(`/${row.id}`).set('x-test-role', 'admin').send({ host: 'replacement.example.test', username: 'monitor', configVersion: row.config_version });
  assert.equal(edit.status, 200);
  release(found('fresh-identity'));
  assert.equal((await pending).status, 409);
  const [saved] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, row.id));
  assert.equal(saved.system_uuid, null);
  assert.equal(saved.target_host, 'replacement.example.test');
});

test('authentication and TLS failures expose categories without leaking credentials', async () => {
  const [row] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-b`));
  for (const [code, status] of [['authentication_failed', 403], ['tls_failed', 502]] as const) {
    discovery = async () => { throw new IloError(code, `${code} while testing fixture-secret`); };
    const result = await request(app).post(`/${row.id}/test`).set('x-test-role', 'admin');
    assert.equal(result.status, status);
    assert.equal(result.body.status, code);
    assert.equal(JSON.stringify(result.body).includes('fixture-secret'), false);
  }
});

test('missing stable identity cannot enable telemetry', async () => {
  const [row] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-b`));
  discovery = async () => ({ ...found(''), identity: { uuid: null, serial: null } });
  const result = await request(app).post(`/${row.id}/test`).set('x-test-role', 'admin');
  assert.equal(result.status, 200);
  assert.equal(result.body.connection.last_status, 'unsupported_identity');
  const enabled = await request(app).put(`/${row.id}/collection`).set('x-test-role', 'admin').send({ enabled: true, configVersion: result.body.connection.config_version });
  assert.equal(enabled.status, 409);
});

test('unsupported power monitoring cannot be enabled even with stable identity', async () => {
  const [row] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-b`));
  discovery = async () => ({ ...found('second-server'), sample: { watts: null, origin: null, unit: 'W', observedAt: new Date().toISOString() },
    capabilities: { monitoring: 'unsupported', runtimeMode: 'supported', writePrivilege: 'unverified' } });
  const result = await request(app).post(`/${row.id}/test`).set('x-test-role', 'admin');
  assert.equal(result.status, 200);
  const enabled = await request(app).put(`/${row.id}/collection`).set('x-test-role', 'admin').send({ enabled: true, configVersion: result.body.connection.config_version });
  assert.equal(enabled.status, 409);
});

test('explicit rebind keeps hardware ID and historical node snapshot while disabling automation', async () => {
  const [row] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-b`));
  const observedAt = new Date('2026-10-08T12:00:00Z');
  await fixture.db.insert(hardwarePowerSamples).values({ hardware_id: row.id, node_ref: row.node_ref, observed_at: observedAt, watts: '250', mode: 'dynamic', origin: 'fixture', device_epoch: row.system_uuid });
  await fixture.db.update(hardwareConnections).set({ collection_enabled: true, control_enabled: true }).where(eq(hardwareConnections.id, row.id));
  const stale = await request(app).post(`/${row.id}/rebind`).set('x-test-role', 'admin').send({ nodeRef: `${hostId}~pve-renamed`, configVersion: row.config_version + 1 });
  assert.equal(stale.status, 409);
  const rebound = await request(app).post(`/${row.id}/rebind`).set('x-test-role', 'admin').send({ nodeRef: `${hostId}~pve-renamed`, configVersion: row.config_version });
  assert.equal(rebound.status, 200, JSON.stringify(rebound.body));
  assert.equal(rebound.body.id, row.id);
  assert.equal(rebound.body.system_uuid, 'second-server');
  assert.equal(rebound.body.collection_enabled, false);
  assert.equal(rebound.body.control_enabled, false);
  assert.equal(rebound.body.last_status, 'not_tested');
  const [sample] = await fixture.db.select().from(hardwarePowerSamples).where(eq(hardwarePowerSamples.hardware_id, row.id));
  assert.equal(sample.node_ref, `${hostId}~pve-b`);
  assert.equal((await request(app).get('/').set('x-test-role', 'admin')).body.some((connection: any) => connection.node_ref === `${hostId}~pve-renamed`), true);
});

test('decommission preserves identity and history while making the old binding inactive', async () => {
  const [row] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.node_ref, `${hostId}~pve-a`));
  const result = await request(app).delete(`/${row.id}`).set('x-test-role', 'admin');
  assert.equal(result.status, 200);
  const [archived] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, row.id));
  assert.equal(archived.lifecycle_state, 'decommissioned');
  assert.equal(archived.system_uuid, 'fixture-uuid');
  assert.equal(archived.secret, '');
  assert.equal(archived.collection_enabled, false);
  assert.equal(archived.control_enabled, false);
});
