import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate.ts';

const adminUrl = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const migrationsDirectory = new URL('../../drizzle/', import.meta.url);

test('0012 upgrades an existing 0011 database without changing finalized accounting or meter history', async () => {
  const name = `homelabrrr_upgrade_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const testUrl = new URL(adminUrl); testUrl.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 2 });
  try {
    const files = (await readdir(migrationsDirectory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
    for (const file of files.filter((file) => Number(file.slice(0, 4)) <= 11)) {
      const sql = (await readFile(join(fileURLToPath(migrationsDirectory), file), 'utf8')).replaceAll('--> statement-breakpoint', '');
      await pool.query(sql);
    }
    await pool.query(`INSERT INTO electricity_contracts (id, label, kind, area, valid_from, valid_to, fixed_dkk_per_kwh, active, provenance)
      VALUES (237, 'existing fixed agreement', 'fixed_all_in', 'DK1', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 2.5, true, 'legacy owner input')`);
    await pool.query(`INSERT INTO electricity_cost_statements (contract_id, period_start, period_end, revision, calculation, finalized, reason)
      VALUES (237, '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z', 1,
      '{"calculatedLabCostOre":"250","methodVersion":"electricity_month_v1"}'::jsonb, true, 'existing finalization')`);
    await pool.query(`INSERT INTO eloverblik_intervals (meter_id, series_key, business_type, aggregation, resolution, interval_start, interval_end, energy_kwh)
      VALUES ('meter-existing', 'import', 'A04', 'Actual', 'PT1H', '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z', 1.25)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of files.filter((file) => Number(file.slice(0, 4)) <= 11)) {
      await pool.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [Number(file.slice(0, 4)), file]);
    }
    assert.equal(await runMigrations(pool), files.filter((file) => Number(file.slice(0, 4)) > 11).length);
    assert.equal(await runMigrations(pool), 0, 'restart must not reapply the migration');
    const { rows: statements } = await pool.query('SELECT calculation, revision FROM electricity_cost_statements WHERE contract_id = 237');
    assert.deepEqual(statements, [{ calculation: { calculatedLabCostOre: '250', methodVersion: 'electricity_month_v1' }, revision: 1 }]);
    const { rows: intervals } = await pool.query("SELECT energy_kwh FROM eloverblik_intervals WHERE meter_id = 'meter-existing'");
    assert.equal(intervals.length, 1); assert.equal(intervals[0].energy_kwh, '1.250000');
    const { rows: loads } = await pool.query('SELECT COUNT(*)::int AS count FROM electricity_extra_loads');
    assert.equal(loads[0].count, 0, 'upgrades must not fabricate extra loads');
    await pool.query(`INSERT INTO electricity_extra_loads (source_key, label, estimated_watts, valid_from, valid_to, excludes_server_energy, provenance)
      VALUES ('rack-switch', 'Rack switch', 35, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', true, 'separate estimate')`);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM electricity_extra_loads')).rows[0].count, 1);
  } finally {
    await pool.end();
    const cleaner = new pg.Client({ connectionString: adminUrl });
    await cleaner.connect();
    await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleaner.end();
  }
});
