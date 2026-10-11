import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { auditLog, hardwareConnections, hardwareEnergyIntervals, hardwarePowerSamples, hardwareTelemetryState, pveHosts } from '../db/schema/index.ts';
import { IloError, type HardwareDiscovery } from './iloAdapter.ts';

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

test('unaligned 60 s samples across quarter-hour boundaries keep every bucket complete', async () => {
  // Fresh physical series so earlier tests' samples cannot border this window.
  const [host] = await fixture.db.select({ id: pveHosts.id }).from(pveHosts).limit(1);
  const { encryptSecret } = await import('../utils/secrets.ts');
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~pve-unaligned`, target_host: 'ilo2.example.test', username: 'reader', secret: encryptSecret('fixture-secret'), system_uuid: 'unaligned-uuid', collection_enabled: true }).returning();
  const start = Date.parse('2026-10-09T09:59:30Z');
  // 09:59:30 .. 10:30:30 every 60 s: buckets 10:00 and 10:15 are fully covered.
  for (let i = 0; i <= 31; i += 1) {
    const at = new Date(start + i * 60_000);
    // Move the poll lease forward so every tick can claim it.
    await fixture.db.execute(sql`UPDATE hardware_telemetry_state SET next_poll_at = ${at}, lease_until = NULL WHERE hardware_id = ${hardware.id}`);
    const result = await poll(hardware.id, () => at, async () => reading(at.toISOString(), 400, 'UNALIGNED-UUID'));
    assert.equal(result.status, 'ok');
  }
  const rows = await fixture.db.select().from(hardwareEnergyIntervals).where(eq(hardwareEnergyIntervals.hardware_id, hardware.id)).orderBy(hardwareEnergyIntervals.start_utc);
  const byStart = new Map(rows.map((row) => [row.start_utc.toISOString(), row]));
  for (const bucket of ['2026-10-09T10:00:00.000Z', '2026-10-09T10:15:00.000Z']) {
    const row = byStart.get(bucket);
    assert.ok(row, `bucket ${bucket} exists`);
    assert.equal(row.covered_seconds, 900, `bucket ${bucket} keeps its head segment`);
    assert.equal(row.quality, 'integrated_complete');
    assert.ok(Math.abs(Number(row.kwh) - 0.1) < 1e-9, `400 W for 15 min is 0.1 kWh, got ${row.kwh}`);
  }
  // Edge buckets hold exactly the covered tail/head: 30 s each.
  assert.equal(byStart.get('2026-10-09T09:45:00.000Z')?.covered_seconds, 30);
  assert.equal(byStart.get('2026-10-09T10:30:00.000Z')?.covered_seconds, 30);
  const totalSeconds = rows.reduce((sum, row) => sum + row.covered_seconds, 0);
  assert.equal(totalSeconds, 31 * 60, 'energy is conserved across bucket splits');

  // A late sample inside the first complete bucket rebuilds it without losing its head.
  const pollAt = new Date(start + 32 * 60_000);
  await fixture.db.execute(sql`UPDATE hardware_telemetry_state SET next_poll_at = ${pollAt}, lease_until = NULL WHERE hardware_id = ${hardware.id}`);
  assert.equal((await poll(hardware.id, () => pollAt, async () => reading('2026-10-09T10:31:00Z', 400, 'UNALIGNED-UUID'))).status, 'ok');
  const [first] = await fixture.db.select().from(hardwareEnergyIntervals).where(and(eq(hardwareEnergyIntervals.hardware_id, hardware.id), eq(hardwareEnergyIntervals.start_utc, new Date('2026-10-09T10:00:00Z'))));
  assert.equal(first.covered_seconds, 900);
});

test('repeated authentication failures back off and auto-disable collection', async () => {
  const [host] = await fixture.db.select({ id: pveHosts.id }).from(pveHosts).limit(1);
  const { encryptSecret } = await import('../utils/secrets.ts');
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~pve-auth`, target_host: 'ilo3.example.test', username: 'reader', secret: encryptSecret('fixture-secret'), system_uuid: 'auth-uuid', collection_enabled: true, last_status: 'online' }).returning();
  const denied = async (): Promise<HardwareDiscovery> => { throw new IloError('authentication_failed', 'fixture denial'); };
  let at = new Date('2026-10-10T08:00:00Z');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fixture.db.update(hardwareTelemetryState).set({ next_poll_at: at, lease_until: null }).where(eq(hardwareTelemetryState.hardware_id, hardware.id));
    const result = await poll(hardware.id, () => at, denied);
    assert.equal(result.status, 'failed');
    const [state] = await fixture.db.select().from(hardwareTelemetryState).where(eq(hardwareTelemetryState.hardware_id, hardware.id));
    assert.equal(state.auth_failure_count, attempt);
    assert.ok(state.next_poll_at.getTime() - at.getTime() >= 15 * 60_000, 'credential failures never retry quickly');
    const [connection] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, hardware.id));
    assert.equal(connection.collection_enabled, attempt < 3);
    if (attempt === 3) {
      assert.equal(connection.last_status, 'authentication_failed');
      assert.equal(connection.config_version, hardware.config_version + 1);
      assert.equal((result as any).disabled, true);
    }
    at = new Date(at.getTime() + 60 * 60_000);
  }
  const audits = await fixture.db.select().from(auditLog).where(eq(auditLog.action, 'hardware_collection_auto_disabled'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.includes('fixture-secret'), false);
  // Disabled collection performs no further iLO logins.
  await fixture.db.update(hardwareTelemetryState).set({ next_poll_at: at, lease_until: null }).where(eq(hardwareTelemetryState.hardware_id, hardware.id));
  assert.equal((await poll(hardware.id, () => at, async () => { throw new Error('reader must not run'); })).status, 'disabled');
});

test('non-credential failures do not count towards the authentication lockout', async () => {
  const [host] = await fixture.db.select({ id: pveHosts.id }).from(pveHosts).limit(1);
  const { encryptSecret } = await import('../utils/secrets.ts');
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~pve-flaky`, target_host: 'ilo4.example.test', username: 'reader', secret: encryptSecret('fixture-secret'), system_uuid: 'flaky-uuid', collection_enabled: true }).returning();
  let at = new Date('2026-10-10T08:00:00Z');
  for (const code of ['timeout', 'insufficient_privilege', 'unreachable', 'timeout'] as const) {
    await fixture.db.execute(sql`INSERT INTO hardware_telemetry_state (hardware_id, next_poll_at) VALUES (${hardware.id}, ${at}) ON CONFLICT (hardware_id) DO UPDATE SET next_poll_at = ${at}, lease_until = NULL`);
    await poll(hardware.id, () => at, async () => { throw new IloError(code, 'fixture'); });
    at = new Date(at.getTime() + 60 * 60_000);
  }
  const [state] = await fixture.db.select().from(hardwareTelemetryState).where(eq(hardwareTelemetryState.hardware_id, hardware.id));
  assert.equal(state.auth_failure_count, 0);
  const [connection] = await fixture.db.select().from(hardwareConnections).where(eq(hardwareConnections.id, hardware.id));
  assert.equal(connection.collection_enabled, true);
});
