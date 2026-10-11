import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, provisionedVms, eloverblikIntervals, electricitySpotPrices } from '../db/schema/index.ts';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

test('maintenance deletes bounded terminal history while preserving recent and active rows', async () => {
  const t = await createTestDatabase();
  // databaseMaintenance imports the shared pool from db/client.ts, which reads
  // DATABASE_URL at module-eval time — point it at the throwaway database and
  // import lazily so the service runs against the same physical database the
  // fixtures below write to.
  process.env.DATABASE_URL = t.url;
  process.env.JOB_RETENTION_DAYS = '90';
  const { runDatabaseMaintenance, databaseMaintenanceStatus } = await import('./databaseMaintenance.ts');
  try {
    const [user] = await t.db
      .insert(users)
      .values({ username: 'retention-admin', password: 'x' })
      .returning({ id: users.id });

    await t.db.insert(provisionedVms).values([
      { user_id: user.id, node: '1~pve', vmid: 401, name: 'old-one', status: 'ready', created_at: daysAgo(91) },
      { user_id: user.id, node: '1~pve', vmid: 402, name: 'old-two', status: 'error', created_at: daysAgo(92) },
      { user_id: user.id, node: '1~pve', vmid: 403, name: 'recent', status: 'ready', created_at: daysAgo(89) },
      { user_id: user.id, node: '1~pve', vmid: 404, name: 'active', status: 'creating', created_at: daysAgo(200) },
    ]);

    // batchSize 1 deletes exactly the single oldest terminal row per pass.
    const first = await runDatabaseMaintenance({ batchSize: 1 });
    assert.equal(first.deleted.provisioned_vms, 1);

    const second = await runDatabaseMaintenance({ batchSize: 1 });
    assert.equal(second.deleted.provisioned_vms, 1);

    // Both terminal rows older than the retention window are gone; the recent
    // terminal row and the non-terminal ('creating') row survive regardless of age.
    const remaining = await t.db.select({ name: provisionedVms.name }).from(provisionedVms);
    const names = remaining.map((r) => r.name).sort();
    assert.deepEqual(names, ['active', 'recent']);

    // Energy history keeps five years by default.
    const interval = (days: number) => ({ meter_id: '571313180000000001', series_key: 'A04:KWH:A01', business_type: 'A04', aggregation: 'Actual', resolution: 'PT1H',
      interval_start: daysAgo(days), interval_end: new Date(daysAgo(days).getTime() + 3_600_000), energy_kwh: '0.100000' });
    await t.db.insert(eloverblikIntervals).values([interval(1900), interval(1000)]);
    await t.db.insert(electricitySpotPrices).values([1900, 10].map((days) => ({ area: 'DK2', start_utc: daysAgo(days), end_utc: new Date(daysAgo(days).getTime() + 900_000),
      dkk_per_kwh: '0.500000', source_revision: 'fixture', fetched_at: daysAgo(days) })));
    const energy = await runDatabaseMaintenance({ batchSize: 10 });
    assert.equal(energy.deleted.eloverblik_intervals, 1);
    assert.equal(energy.deleted.electricity_spot_prices, 1);

    // A third pass has nothing terminal left to delete.
    const third = await runDatabaseMaintenance({ batchSize: 1 });
    assert.equal(third.deleted.provisioned_vms ?? 0, 0);

    // The last-run record is persisted to settings and reflected in status.
    const status = await databaseMaintenanceStatus();
    assert.ok(status.lastRun);
    assert.equal(status.retentionDays.jobs, 90);
    assert.equal(status.tables.provisioned_vms.count, 2);
    assert.equal(typeof status.databaseBytes, 'number');
    assert.ok(status.tables.provisioned_vms.oldest instanceof Date);
  } finally {
    await t.drop();
  }
});
