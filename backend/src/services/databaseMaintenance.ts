import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { getSetting, setSetting } from '../db/settings.ts';

function envDays(name: string, fallback: number) {
  const value = Number(process.env[name] || String(fallback));
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

// table/timestamp are the whitelist for the dynamic identifiers below; `where`
// is a constant predicate emitted verbatim (never user input).
const POLICIES = [
  { table: 'audit_log', timestamp: 'created_at', days: () => envDays('AUDIT_RETENTION_DAYS', 365), where: '1 = 1' },
  { table: 'provisioned_vms', timestamp: 'created_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status IN ('ready','error','timeout','failed')" },
  { table: 'vm_migrations', timestamp: 'finished_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status IN ('ok','error','failed','timeout')" },
  { table: 'backup_tasks', timestamp: 'created_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status NOT IN ('running','queued')" },
  { table: 'workflow_runs', timestamp: 'created_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status NOT IN ('running','queued')" },
];

async function tableExists(name: string) {
  // to_regclass resolves to NULL when the relation is absent — the PostgreSQL
  // replacement for the old sqlite_master lookup.
  const res = await db.execute<{ reg: string | null }>(sql`SELECT to_regclass(${'public.' + name}) AS reg`);
  return res.rows[0]?.reg != null;
}

export async function runDatabaseMaintenance({ batchSize = 500 }: { batchSize?: number } = {}) {
  const parsedBatch = Number(batchSize);
  const safeBatch = Number.isInteger(parsedBatch) && parsedBatch >= 1
    ? Math.min(5000, parsedBatch)
    : 500;
  const result: { startedAt: string; deleted: Record<string, number>; finishedAt?: string } = {
    startedAt: new Date().toISOString(),
    deleted: {},
  };
  for (const policy of POLICIES) {
    if (!await tableExists(policy.table)) continue;
    const days = policy.days();
    // Bounded, oldest-first delete: the id-in-subquery keeps the LIMIT honoured
    // and the make_interval cutoff replaces the SQLite `datetime('now', ?)` modifier.
    const deleted = await db.execute(sql`
      DELETE FROM ${sql.identifier(policy.table)}
      WHERE id IN (
        SELECT id FROM ${sql.identifier(policy.table)}
        WHERE ${sql.raw(policy.where)} AND ${sql.identifier(policy.timestamp)} IS NOT NULL
          AND ${sql.identifier(policy.timestamp)} < now() - make_interval(days => ${days})
        ORDER BY ${sql.identifier(policy.timestamp)} ASC LIMIT ${safeBatch}
      )
    `);
    result.deleted[policy.table] = deleted.rowCount ?? 0;
  }
  // ANALYZE refreshes the planner statistics (the PostgreSQL analogue of the
  // old `PRAGMA optimize`). PostgreSQL autovacuum reclaims space on its own, so
  // there is no WAL checkpoint step to run here.
  await db.execute(sql`ANALYZE`);
  result.finishedAt = new Date().toISOString();
  await setSetting('database_maintenance_last', JSON.stringify(result));
  return result;
}

export async function databaseMaintenanceStatus() {
  const sizeRes = await db.execute<{ db_bytes: string }>(sql`SELECT pg_database_size(current_database()) AS db_bytes`);
  const databaseBytes = Number(sizeRes.rows[0]?.db_bytes ?? 0);
  // No per-database WAL file in PostgreSQL (the WAL is cluster-global), so the
  // ops payload's WAL figure — rendered by admin/OperationsPage.jsx — is 0.
  const walBytes = 0;
  // "Reclaimable" is surfaced through the existing bytes field consumed by
  // admin/OperationsPage.jsx; in PostgreSQL the closest bloat signal is the
  // dead-tuple count that autovacuum will reclaim (a row count, not bytes).
  const deadRes = await db.execute<{ dead: string }>(sql`SELECT COALESCE(SUM(n_dead_tup), 0) AS dead FROM pg_stat_user_tables`);
  const reclaimableBytes = Number(deadRes.rows[0]?.dead ?? 0);

  const tables: Record<string, { count: number; oldest: Date | null; bytes: number }> = {};
  for (const policy of POLICIES) {
    if (!await tableExists(policy.table)) continue;
    // Raw db.execute bypasses Drizzle's column mode mapping, so timestamptz
    // arrives as a string here — normalise it to a Date (conventions rule M8).
    const res = await db.execute<{ count: number; oldest: string | null; bytes: string }>(sql`
      SELECT COUNT(*)::int AS count,
             MIN(${sql.identifier(policy.timestamp)}) AS oldest,
             pg_total_relation_size(${'public.' + policy.table}::regclass) AS bytes
      FROM ${sql.identifier(policy.table)}
    `);
    const row = res.rows[0];
    tables[policy.table] = {
      count: Number(row?.count ?? 0),
      oldest: row?.oldest ? new Date(row.oldest) : null,
      bytes: Number(row?.bytes ?? 0),
    };
  }
  const lastValue = await getSetting('database_maintenance_last');
  return {
    databaseBytes,
    walBytes,
    reclaimableBytes,
    retentionDays: {
      audit: envDays('AUDIT_RETENTION_DAYS', 365),
      jobs: envDays('JOB_RETENTION_DAYS', 90),
    },
    tables,
    // settings.value stays text (conventions rule M7 exception) — keep parsing it.
    lastRun: lastValue ? JSON.parse(lastValue) : null,
  };
}
