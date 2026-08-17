import db from '../db.ts';
import { statSync } from 'node:fs';
import { retentionModifier } from '../utils/retention.ts';

function envDays(name, fallback) {
  const value = Number(process.env[name] || String(fallback));
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

const POLICIES = [
  { table: 'audit_log', timestamp: 'created_at', days: () => envDays('AUDIT_RETENTION_DAYS', 365), where: '1 = 1' },
  { table: 'provisioned_vms', timestamp: 'created_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status IN ('ready','error','timeout','failed')" },
  { table: 'vm_migrations', timestamp: 'finished_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status IN ('ok','error','failed','timeout')" },
  { table: 'backup_tasks', timestamp: 'created_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status NOT IN ('running','queued')" },
  { table: 'workflow_runs', timestamp: 'created_at', days: () => envDays('JOB_RETENTION_DAYS', 90), where: "status NOT IN ('running','queued')" },
];

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function runDatabaseMaintenance({ batchSize = 500 } = {}) {
  const parsedBatch = Number(batchSize);
  const safeBatch = Number.isInteger(parsedBatch) && parsedBatch >= 1
    ? Math.min(5000, parsedBatch)
    : 500;
  const result = { startedAt: new Date().toISOString(), deleted: {}, checkpoint: null };
  for (const policy of POLICIES) {
    if (!tableExists(policy.table)) continue;
    const modifier = retentionModifier(policy.days());
    const statement = db.prepare(`
      DELETE FROM ${policy.table}
      WHERE rowid IN (
        SELECT rowid FROM ${policy.table}
        WHERE ${policy.where} AND ${policy.timestamp} IS NOT NULL
          AND ${policy.timestamp} < datetime('now', ?)
        ORDER BY ${policy.timestamp} ASC LIMIT ?
      )
    `);
    result.deleted[policy.table] = statement.run(modifier, safeBatch).changes;
  }
  db.pragma('optimize');
  result.checkpoint = db.pragma('wal_checkpoint(PASSIVE)');
  result.finishedAt = new Date().toISOString();
  db.prepare("INSERT INTO settings (key, value) VALUES ('database_maintenance_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(result));
  return result;
}

export function databaseMaintenanceStatus() {
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const freelist = Number(db.pragma('freelist_count', { simple: true }));
  const tables = {};
  for (const policy of POLICIES) {
    if (!tableExists(policy.table)) continue;
    tables[policy.table] = db.prepare(`SELECT COUNT(*) AS count, MIN(${policy.timestamp}) AS oldest FROM ${policy.table}`).get();
  }
  const last = db.prepare("SELECT value FROM settings WHERE key = 'database_maintenance_last'").get();
  let walBytes = 0;
  try { walBytes = statSync(`${db.name}-wal`).size; } catch { /* no WAL file yet */ }
  return {
    databaseBytes: pageCount * pageSize,
    walBytes,
    reclaimableBytes: freelist * pageSize,
    retentionDays: {
      audit: envDays('AUDIT_RETENTION_DAYS', 365),
      jobs: envDays('JOB_RETENTION_DAYS', 90),
    },
    tables,
    lastRun: last ? JSON.parse(last.value) : null,
  };
}
