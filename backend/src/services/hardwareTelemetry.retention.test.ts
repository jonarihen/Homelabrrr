import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { hardwareConnections, hardwareEnergyDays, hardwareEnergyIntervals, pveHosts } from '../db/schema/index.ts';

let fixture: TestDatabase;
let closeDb: () => Promise<void>;
let hardwareId: number;
let retain: typeof import('./hardwareTelemetry.ts').runHardwareTelemetryRetention;

before(async () => {
  fixture = await createTestDatabase();
  process.env.DATABASE_URL = fixture.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ runHardwareTelemetryRetention: retain } = await import('./hardwareTelemetry.ts'));
  const [host] = await fixture.db.insert(pveHosts).values({ name: 'pve', host: 'pve.example.test', token_id: 'fixture', token_secret: 'fixture' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: host.id, node_ref: `${host.id}~pve-a`, target_host: 'ilo.example.test', username: 'reader', secret: 'fixture' }).returning();
  hardwareId = hardware.id;
});

after(async () => { await closeDb?.(); await fixture?.drop(); });

async function insertDay(startUtc: string, count: number, omitted = -1) {
  const start = Date.parse(startUtc);
  const rows = Array.from({ length: count }, (_, index) => index).filter((index) => index !== omitted).map((index) => ({
    hardware_id: hardwareId, start_utc: new Date(start + index * 900_000), end_utc: new Date(start + (index + 1) * 900_000),
    kwh: '0.062500000', covered_seconds: 900, expected_seconds: 900, quality: 'integrated_complete', method_version: 'trapezoid_v1',
  }));
  await fixture.db.insert(hardwareEnergyIntervals).values(rows);
}

test('daily rollup uses 23-hour and 25-hour Copenhagen days and is idempotent', async () => {
  await insertDay('2026-03-28T23:00:00Z', 92);
  await insertDay('2026-10-24T22:00:00Z', 100, 20);
  const now = new Date('2027-01-01T12:00:00Z');
  await retain(now);
  const first = await fixture.db.select().from(hardwareEnergyDays).where(eq(hardwareEnergyDays.hardware_id, hardwareId));
  const spring = first.find((row) => row.local_date === '2026-03-29');
  const autumn = first.find((row) => row.local_date === '2026-10-25');
  assert.equal(spring?.expected_seconds, 23 * 3600);
  assert.equal(spring?.covered_seconds, 23 * 3600);
  assert.equal(Number(spring?.kwh), 5.75);
  assert.equal(spring?.quality, 'integrated_complete');
  assert.equal(autumn?.expected_seconds, 25 * 3600);
  assert.equal(autumn?.covered_seconds, 99 * 900);
  assert.equal(Number(autumn?.kwh), 6.1875);
  assert.equal(autumn?.quality, 'integrated_partial');
  await retain(now);
  const second = await fixture.db.select().from(hardwareEnergyDays).where(eq(hardwareEnergyDays.hardware_id, hardwareId));
  assert.deepEqual(second, first);
});

test('retention preserves the entire local cutoff day until it can be pruned whole', async () => {
  await insertDay('2026-10-23T22:00:00Z', 96);
  const cutoffInsideDay = new Date('2028-10-23T12:00:00Z'); // 730-day cutoff = 2026-10-24 12:00 UTC
  await retain(cutoffInsideDay);
  await retain(cutoffInsideDay);
  const localDay = '2026-10-24';
  const [day] = await fixture.db.select().from(hardwareEnergyDays).where(and(eq(hardwareEnergyDays.hardware_id, hardwareId), eq(hardwareEnergyDays.local_date, localDay)));
  assert.equal(Number(day.kwh), 6);
  assert.equal(day.covered_seconds, 86400);
  const stillRetained = await fixture.db.select().from(hardwareEnergyIntervals).where(and(eq(hardwareEnergyIntervals.hardware_id, hardwareId),
    eq(hardwareEnergyIntervals.start_utc, new Date('2026-10-23T22:00:00Z'))));
  assert.equal(stillRetained.length, 1);
  await retain(new Date('2028-10-24T12:00:00Z')); // cutoff moved to next local day
  const pruned = await fixture.db.select().from(hardwareEnergyIntervals).where(and(eq(hardwareEnergyIntervals.hardware_id, hardwareId),
    eq(hardwareEnergyIntervals.start_utc, new Date('2026-10-23T22:00:00Z'))));
  assert.equal(pruned.length, 0);
  const [preserved] = await fixture.db.select().from(hardwareEnergyDays).where(and(eq(hardwareEnergyDays.hardware_id, hardwareId), eq(hardwareEnergyDays.local_date, localDay)));
  assert.equal(Number(preserved.kwh), 6);
});
