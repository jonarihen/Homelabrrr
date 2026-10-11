import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, hardwareEnergyIntervals, hardwarePowerSamples, pveHosts } from '../db/schema/index.ts';
import type { HardwareDiscovery } from './iloAdapter.ts';

let fixture: TestDatabase;
let closeDb: () => Promise<void>;
let hardwareId: number;
let poll: typeof import('./hardwareTelemetry.ts').pollHardwareConnection;

before(async () => {
  fixture = await createTestDatabase();
  // The integration owner will generate migration 0011 after 0010 lands.
  await fixture.db.execute(sql`ALTER TABLE hardware_power_samples ADD COLUMN IF NOT EXISTS health jsonb`);
  process.env.DATABASE_URL = fixture.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ pollHardwareConnection: poll } = await import('./hardwareTelemetry.ts'));
  const { encryptSecret } = await import('../utils/secrets.ts');
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'pve', host: 'pve.example.test', token_id: 'fixture', token_secret: 'fixture' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~pve-a`, target_host: 'ilo.example.test', username: 'reader', secret: encryptSecret('fixture-secret'), system_uuid: 'fixture-uuid', collection_enabled: true }).returning();
  hardwareId = hardware.id;
});

after(async () => { await closeDb?.(); await fixture?.drop(); });

function reading(at: string, watts: number, identity = 'FIXTURE-UUID'): HardwareDiscovery {
  return { identity: { uuid: identity, serial: null }, model: 'DL380', generation: 'ilo5', firmware: 'fixture',
    mode: { value: 'dynamic', origin: '/redfish/v1/Systems/1#Oem.Hpe.PowerRegulatorMode' },
    capabilities: { monitoring: 'supported', runtimeMode: 'supported', writePrivilege: 'unverified' },
    sample: { watts, origin: '/redfish/v1/Chassis/1/Power#PowerControl.PowerConsumedWatts', unit: 'W', observedAt: at } };
}

test('collector lease prevents duplicate polls and writes one sample', async () => {
  const at = new Date('2026-10-08T15:00:00Z');
  let calls = 0;
  const reader = async () => { calls += 1; return reading(at.toISOString(), 250); };
  const results = await Promise.all([poll(hardwareId, () => at, reader), poll(hardwareId, () => at, reader)]);
  assert.deepEqual(results.map((x) => x.status).sort(), ['ok', 'skipped']);
  assert.equal(calls, 1);
  assert.equal((await fixture.db.select().from(hardwarePowerSamples)).length, 1);
  assert.equal((await fixture.db.select().from(hardwareEnergyIntervals)).length, 0, 'one instant has no duration');
});

test('late samples recompute stored energy instead of adding a second bucket', async () => {
  const second = new Date('2026-10-08T15:01:00Z');
  assert.equal((await poll(hardwareId, () => second, async () => reading(second.toISOString(), 250))).status, 'ok');
  const third = new Date('2026-10-08T15:02:00Z');
  assert.equal((await poll(hardwareId, () => third, async () => reading(third.toISOString(), 250))).status, 'ok');
  const [before] = await fixture.db.select().from(hardwareEnergyIntervals).where(eq(hardwareEnergyIntervals.hardware_id, hardwareId));
  assert.equal(before.covered_seconds, 120);
  assert.ok(Math.abs(Number(before.kwh) - 250 * 120 / 3_600_000) < 1e-8);

  const pollAt = new Date('2026-10-08T15:03:00Z');
  const lateAt = '2026-10-08T15:01:30Z';
  assert.equal((await poll(hardwareId, () => pollAt, async () => reading(lateAt, 1000))).status, 'ok');
  const intervals = await fixture.db.select().from(hardwareEnergyIntervals).where(eq(hardwareEnergyIntervals.hardware_id, hardwareId));
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].covered_seconds, 120);
  assert.ok(Number(intervals[0].kwh) > Number(before.kwh));
  assert.equal((await fixture.db.select().from(hardwarePowerSamples)).length, 4);
});

test('identity mismatch leaves measurements unchanged and records a failure', async () => {
  const at = new Date('2026-10-08T15:04:00Z');
  const before = (await fixture.db.select().from(hardwarePowerSamples)).length;
  const result = await poll(hardwareId, () => at, async () => reading(at.toISOString(), 500, 'another-server'));
  assert.deepEqual(result, { status: 'failed', code: 'HARDWARE_IDENTITY_CHANGED' });
  assert.equal((await fixture.db.select().from(hardwarePowerSamples)).length, before);
});

test('collector persists only normalized optional health from the same observation', async () => {
  const at = new Date('2026-10-08T16:00:00Z');
  const sample = reading(at.toISOString(), 250);
  sample.sample.health = { temperatures: [{ name: 'Inlet', celsius: 21, health: 'OK', secret: 'must-not-store' } as any],
    fans: [{ name: 'Fan 1', value: 0, unit: 'percent', health: 'OK' }],
    powerSupplies: [{ name: 'PSU 1', health: 'OK', state: 'Enabled' }], powerRedundancy: { health: 'OK', state: null }, limited: false };
  assert.equal((await poll(hardwareId, () => at, async () => sample)).status, 'ok');
  const [stored] = await fixture.db.select().from(hardwarePowerSamples).where(eq(hardwarePowerSamples.observed_at, at));
  assert.equal((stored.health as any).temperatures[0].celsius, 21);
  assert.equal((stored.health as any).fans[0].value, 0);
  assert.equal(JSON.stringify(stored.health).includes('must-not-store'), false);
});

test('changed configuration disables collection without extending history', async () => {
  const [connection] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, hardwareId));
  await fixture.db.update(hardwareConnections).set({ collection_enabled: false, config_version: connection.config_version + 1 }).where(eq(hardwareConnections.id, hardwareId));
  const at = new Date('2026-10-08T17:00:00Z');
  const result = await poll(hardwareId, () => at, async () => { throw new Error('reader must not run'); });
  assert.equal(result.status, 'disabled');
  const remaining = await fixture.db.select().from(hardwarePowerSamples).where(and(eq(hardwarePowerSamples.hardware_id, hardwareId), eq(hardwarePowerSamples.observed_at, at)));
  assert.equal(remaining.length, 0);
});
