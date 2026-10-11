import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import * as schema from '../db/schema/index.ts';
import { runMigrations } from '../db/migrate.ts';

const { hardwareConnections, hardwareEnergyDays, hardwareEnergyIntervals, hardwarePowerSamples, hardwareTelemetryState, pveHosts } = schema;
const execFileAsync = promisify(execFile);
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Same rule as backupService.test.ts: needs pg_dump/pg_restore at least the
// server's major version (CI installs them); skipped only when unavailable.
async function skipReason(): Promise<string | false> {
  try {
    const { stdout } = await execFileAsync('pg_dump', ['--version']);
    const dumpMajor = Number(/(\d+)\./.exec(stdout)?.[1]);
    const client = new pg.Client({ connectionString: ADMIN_URL });
    await client.connect();
    const { rows } = await client.query('SHOW server_version');
    await client.end();
    const serverMajor = Number(/(\d+)/.exec(String(rows[0].server_version))?.[1]);
    if (!Number.isFinite(dumpMajor) || !Number.isFinite(serverMajor)) return 'could not determine pg_dump/server versions';
    return dumpMajor < serverMajor ? `pg_dump ${dumpMajor} is older than server ${serverMajor}` : false;
  } catch (err) {
    return `pg_dump unavailable: ${(err as Error).message}`;
  }
}

function run(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`))));
    child.stdin.end(input);
  });
}

test('hardware tables survive an encrypted-at-rest dump/restore without duplicating collector work', { skip: await skipReason() }, async () => {
  const source = await createTestDatabase();
  const targetName = `homelabrrr_restore_${crypto.randomBytes(6).toString('hex')}`;
  const targetUrl = new URL(ADMIN_URL); targetUrl.pathname = `/${targetName}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${targetName}`);
  await admin.end();
  const target = new pg.Pool({ connectionString: targetUrl.toString(), max: 3 });
  process.env.DATABASE_URL = targetUrl.toString();
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { encryptSecret, decryptSecret } = await import('../utils/secrets.ts');
    const leaseUntil = new Date(Date.now() + 10 * 60_000);
    const [host] = await source.db.insert(pveHosts).values({ name: 'pve', host: 'pve.example.test', token_id: 't', token_secret: 't' }).returning();
    const [active] = await source.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~a`, target_host: 'ilo-a.example.test', username: 'reader', secret: encryptSecret('fixture-secret'), system_uuid: 'uuid-a', collection_enabled: true, last_status: 'online' }).returning();
    await source.db.insert(hardwareConnections).values({ pve_host_id: null, node_ref: `${host.id}~old`, target_host: 'ilo-old.example.test', username: 'reader', secret: '', system_uuid: 'uuid-old', lifecycle_state: 'decommissioned' });
    await source.db.insert(hardwareTelemetryState).values({ hardware_id: active.id, lease_until: leaseUntil, next_poll_at: leaseUntil, failure_count: 2, auth_failure_count: 1 });
    await source.db.insert(hardwarePowerSamples).values([0, 1, 2].map((m) => ({ hardware_id: active.id, node_ref: active.node_ref, observed_at: new Date(Date.UTC(2026, 9, 9, 10, m)), watts: '250.125', mode: 'dynamic', origin: 'fixture', device_epoch: 'uuid-a',
      health: { temperatures: [{ name: 'Inlet', celsius: 21, health: 'OK' }], fans: [], powerSupplies: [], powerRedundancy: null, limited: false } })));
    await source.db.insert(hardwareEnergyIntervals).values({ hardware_id: active.id, start_utc: new Date('2026-10-09T10:00:00Z'), end_utc: new Date('2026-10-09T10:15:00Z'), kwh: '0.008337500', covered_seconds: 120, expected_seconds: 900, quality: 'integrated_partial', method_version: 'trapezoid_v1' });
    await source.db.insert(hardwareEnergyDays).values({ hardware_id: active.id, local_date: '2026-10-08', kwh: '6.123456789', covered_seconds: 86400, expected_seconds: 86400, quality: 'integrated_complete', method_version: 'trapezoid_v1' });

    const dump = await run('pg_dump', ['--format=custom', '--no-owner', `--dbname=${source.url}`]);
    await run('pg_restore', ['--no-owner', '--exit-on-error', `--dbname=${targetUrl.toString()}`], dump);
    const restored = drizzle(target, { schema });

    assert.equal(await runMigrations(target), 0, 'restored schema is already at the latest migration');
    const [connection] = await restored.select().from(hardwareConnections).where(eq(hardwareConnections.id, active.id));
    assert.equal(decryptSecret(connection.secret), 'fixture-secret', 'encrypted secret restores under the same key');
    assert.equal((await restored.select().from(hardwareConnections)).length, 2);
    const [days] = await restored.select().from(hardwareEnergyDays);
    assert.equal(days.kwh, '6.123456789');
    const [interval] = await restored.select().from(hardwareEnergyIntervals);
    assert.equal(interval.kwh, '0.008337500');
    const samples = await restored.select().from(hardwarePowerSamples).orderBy(hardwarePowerSamples.observed_at);
    assert.deepEqual(samples.map((s) => s.watts), ['250.125', '250.125', '250.125']);
    assert.equal((samples[0].health as any).temperatures[0].celsius, 21);
    const [state] = await restored.select().from(hardwareTelemetryState);
    assert.equal(state.lease_until?.getTime(), leaseUntil.getTime());
    assert.equal(state.auth_failure_count, 1);

    // Constraints and indexes came back too.
    await assert.rejects(restored.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~a`, target_host: 'x', username: 'r', secret: 'enc' }), 'active node binding stays unique');
    await assert.rejects(restored.insert(hardwareConnections).values({ pve_host_id: null, node_ref: `${host.id}~b`, target_host: 'x', username: 'r', secret: 'enc' }), 'active binding needs a host');
    await assert.rejects(restored.insert(hardwarePowerSamples).values({ hardware_id: active.id, node_ref: active.node_ref, observed_at: samples[0].observed_at, watts: '1', mode: 'low', origin: 'dup' }), 'sample identity stays unique');
    const indexes = await target.query(`SELECT indexname FROM pg_indexes WHERE tablename LIKE 'hardware_%'`);
    for (const name of ['hardware_power_sample_range', 'hardware_energy_interval_range', 'hardware_energy_interval_identity', 'hardware_connections_active_system_unique']) {
      assert.ok(indexes.rows.some((row) => row.indexname === name), name);
    }

    // The restored lease is honoured: the collector does not re-poll (and so
    // cannot double-count) a node another process may still be polling.
    ({ closeDb } = await import('../db/client.ts'));
    const { pollHardwareConnection } = await import('./hardwareTelemetry.ts');
    assert.deepEqual(await pollHardwareConnection(active.id, () => new Date(), async () => { throw new Error('must not read while leased'); }), { status: 'skipped' });
    const [stillOne] = (await restored.execute(sql`SELECT count(*)::int AS n FROM hardware_energy_intervals`)).rows as { n: number }[];
    assert.equal(stillOne.n, 1);
  } finally {
    await closeDb?.();
    await target.end();
    await source.drop();
    const cleaner = new pg.Client({ connectionString: ADMIN_URL });
    await cleaner.connect();
    await cleaner.query(`DROP DATABASE IF EXISTS ${targetName} WITH (FORCE)`);
    await cleaner.end();
  }
});
