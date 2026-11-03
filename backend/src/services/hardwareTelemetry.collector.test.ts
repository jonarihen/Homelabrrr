import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, hardwarePowerSamples, hardwareTelemetryState, pveHosts } from '../db/schema/index.ts';
import { IloError, type HardwareDiscovery, type IloConfig } from './iloAdapter.ts';

// Collector lifecycle: isolation between nodes, lease expiry, decommission
// while a read is in flight, start/stop and metrics. Fixture readers only.
let fixture: TestDatabase;
let closeDb: () => Promise<void>;
let hostId: number;
let collector: typeof import('./hardwareTelemetry.ts');
let metricEvents: typeof import('../utils/metricRegistry.ts').metricEvents;

before(async () => {
  fixture = await createTestDatabase();
  process.env.DATABASE_URL = fixture.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  collector = await import('./hardwareTelemetry.ts');
  ({ metricEvents } = await import('../utils/metricRegistry.ts'));
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'pve', host: 'pve.example.test', token_id: 'fixture', token_secret: 'fixture' }).returning();
  hostId = host.id;
});

after(async () => { await closeDb?.(); await fixture?.drop(); });

async function connection(node: string, uuid: string, targetHost = `${node}.mgmt.example.test`) {
  const { encryptSecret } = await import('../utils/secrets.ts');
  const [row] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: hostId, node_ref: `${hostId}~${node}`, target_host: targetHost, username: 'reader', secret: encryptSecret('fixture-secret'), system_uuid: uuid, collection_enabled: true }).returning();
  return row;
}

function reading(at: Date, uuid: string, watts = 250): HardwareDiscovery {
  return { identity: { uuid, serial: null }, model: 'DL380', generation: 'ilo5', firmware: 'fixture',
    mode: { value: 'dynamic', origin: '/redfish/v1/Systems/1#Oem.Hpe.PowerRegulatorMode' },
    capabilities: { monitoring: 'supported', runtimeMode: 'supported', writePrivilege: 'unverified' },
    sample: { watts, origin: '/redfish/v1/Chassis/1/Power#PowerControl.PowerConsumedWatts', unit: 'W', observedAt: at.toISOString() } };
}

const samplesFor = (id: number) => fixture.db.select().from(hardwarePowerSamples).where(eq(hardwarePowerSamples.hardware_id, id));
const stateFor = async (id: number) => (await fixture.db.select().from(hardwareTelemetryState).where(eq(hardwareTelemetryState.hardware_id, id)))[0];

test('decommission while an iLO read is in flight drops the reading and releases the lease', async () => {
  const row = await connection('mid-poll', 'mid-uuid');
  const at = new Date('2026-10-09T10:00:00Z');
  let release: (value: HardwareDiscovery) => void = () => {};
  let started = false;
  const pending = collector.pollHardwareConnection(row.id, () => at, () => new Promise((resolve) => { release = resolve; started = true; }));
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  await fixture.db.update(hardwareConnections).set({ lifecycle_state: 'decommissioned', collection_enabled: false, secret: '', config_version: row.config_version + 1 }).where(eq(hardwareConnections.id, row.id));
  release(reading(at, 'mid-uuid'));
  assert.deepEqual(await pending, { status: 'stale' });
  assert.equal((await samplesFor(row.id)).length, 0);
  assert.equal((await stateFor(row.id)).lease_until, null);
});

test('a poll whose lease expired cannot write over its successor', async () => {
  const row = await connection('lease', 'lease-uuid');
  const first = new Date('2026-10-09T11:00:00Z');
  let release: (value: HardwareDiscovery) => void = () => {};
  let started = false;
  const slow = collector.pollHardwareConnection(row.id, () => first, () => new Promise((resolve) => { release = resolve; started = true; }));
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  // Three minutes later the 120 s lease has expired; a new worker claims it.
  const later = new Date(first.getTime() + 180_000);
  assert.deepEqual(await collector.pollHardwareConnection(row.id, () => later, async () => reading(later, 'lease-uuid', 300)), { status: 'ok' });
  release(reading(first, 'lease-uuid', 999));
  assert.deepEqual(await slow, { status: 'stale' });
  const samples = await samplesFor(row.id);
  assert.deepEqual(samples.map((sample) => Number(sample.watts)), [300]);
});

test('one failing or throwing node does not stop collection for the others', async () => {
  // Leave only this test's connections eligible for the sweep.
  await fixture.db.update(hardwareConnections).set({ collection_enabled: false });
  const healthy = await connection('healthy', 'healthy-uuid');
  const broken = await connection('broken', 'broken-uuid');
  const crashing = await connection('crashing', 'crashing-uuid');
  const at = new Date('2026-10-09T12:00:00Z');
  const reader = async (config: IloConfig): Promise<HardwareDiscovery> => {
    if (config.host === broken.target_host) throw new IloError('unreachable', 'fixture outage');
    if (config.host === crashing.target_host) throw new TypeError('unexpected vendor shape');
    return reading(at, 'healthy-uuid');
  };
  await collector.sweepHardwareTelemetry(reader, () => at);
  assert.equal((await samplesFor(healthy.id)).length, 1);
  assert.equal((await stateFor(healthy.id)).failure_count, 0);
  assert.equal((await stateFor(broken.id)).last_error_code, 'unreachable');
  assert.equal((await stateFor(crashing.id)).last_error_code, 'COLLECTION_FAILED');
  const events = new Map(metricEvents());
  assert.ok((events.get('hardware_telemetry_polls:result="ok"') || 0) >= 1);
  assert.ok((events.get('hardware_telemetry_polls:result="failed",code="unreachable"') || 0) >= 1);
  assert.ok((events.get('hardware_telemetry_polls:result="failed",code="COLLECTION_FAILED"') || 0) >= 1);
  assert.ok((events.get('hardware_telemetry_sweeps:') || 0) >= 1);
  // Metric labels never carry hosts, IDs or secrets.
  assert.equal(JSON.stringify(metricEvents()).includes('mgmt.example.test'), false);
});

test('a slow node occupies one worker while the others keep being polled', async () => {
  await fixture.db.update(hardwareConnections).set({ collection_enabled: false });
  const rows = [];
  for (const node of ['n1', 'n2', 'n3', 'n4']) rows.push(await connection(node, `${node}-uuid`));
  const at = new Date('2026-10-09T14:00:00Z');
  let slowHost: string | null = null;
  const read = new Set<string>();
  let othersRead: () => void = () => {};
  const allOthersRead = new Promise<boolean>((resolve) => { othersRead = () => resolve(true); });
  let othersFinishedFirst = false;
  const reader = async (config: IloConfig): Promise<HardwareDiscovery> => {
    const uuid = `${config.host.split('.')[0]}-uuid`;
    // Whichever node is read first is the slow one. Paired batching would make
    // the nodes in the next pair wait for it, so it would hit the timeout.
    if (slowHost === null) {
      slowHost = config.host;
      othersFinishedFirst = await Promise.race([allOthersRead, new Promise<boolean>((resolve) => setTimeout(resolve, 2000, false))]);
      return reading(at, uuid);
    }
    read.add(config.host);
    if (read.size === rows.length - 1) othersRead();
    return reading(at, uuid);
  };
  await collector.sweepHardwareTelemetry(reader, () => at);
  assert.equal(othersFinishedFirst, true);
  for (const row of rows) assert.equal((await samplesFor(row.id)).length, 1);
});

test('restart resumes from durable state: a stale lease left by a crash is reclaimed', async () => {
  const row = await connection('restart', 'restart-uuid');
  const crashedAt = new Date('2026-10-09T13:00:00Z');
  await fixture.db.execute(sql`INSERT INTO hardware_telemetry_state (hardware_id, lease_until, next_poll_at) VALUES (${row.id}, ${new Date(crashedAt.getTime() + 120_000)}, ${new Date(crashedAt.getTime() + 120_000)})`);
  const tooEarly = new Date(crashedAt.getTime() + 60_000);
  assert.deepEqual(await collector.pollHardwareConnection(row.id, () => tooEarly, async () => { throw new Error('must not read while leased'); }), { status: 'skipped' });
  const afterExpiry = new Date(crashedAt.getTime() + 121_000);
  assert.deepEqual(await collector.pollHardwareConnection(row.id, () => afterExpiry, async () => reading(afterExpiry, 'restart-uuid')), { status: 'ok' });
});

test('start and stop are idempotent and leave no timer behind', () => {
  assert.equal(collector.hardwareTelemetryRunning(), false);
  collector.startHardwareTelemetry();
  collector.startHardwareTelemetry();
  assert.equal(collector.hardwareTelemetryRunning(), true);
  collector.stopHardwareTelemetry();
  assert.equal(collector.hardwareTelemetryRunning(), false);
  collector.stopHardwareTelemetry();
  assert.equal(collector.hardwareTelemetryRunning(), false);
});
