import db from '../db.js';
import { log } from './logger.js';
import { statSync } from 'node:fs';
import { metricEvents } from './metricRegistry.js';

const startedAt = Date.now();
const counters = new Map();
const durations = new Map();
function keyFor(method, status) {
  return `${method}:${status}`;
}

export function observeRequests(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const key = keyFor(req.method, res.statusCode);
    counters.set(key, (counters.get(key) || 0) + 1);
    const bucket = durations.get(req.method) || { count: 0, sum: 0 };
    bucket.count += 1;
    bucket.sum += durationMs;
    durations.set(req.method, bucket);
    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      actor: req.session?.username || 'anonymous',
      authType: req.apiToken ? 'api_token' : req.session?.userId ? 'session' : 'none',
    });
  });
  next();
}

export function liveness() {
  return { ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) };
}

export function readiness() {
  try {
    const check = db.pragma('quick_check', { simple: true });
    const migrations = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get();
    return { ok: check === 'ok', database: check, schemaVersion: migrations.version };
  } catch {
    // Readiness is intentionally unauthenticated for container orchestrators;
    // never reflect SQLite paths, SQL text, or other internal exception detail.
    return { ok: false, database: 'unavailable', error: 'Database readiness check failed' };
  }
}

function safeLabel(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
}

export function metricsText({ vncWebSockets = 0, sshWebSockets = 0 } = {}) {
  const lines = [
    '# HELP homelabrrr_uptime_seconds Process uptime.',
    '# TYPE homelabrrr_uptime_seconds gauge',
    `homelabrrr_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
  ];
  for (const [key, count] of [...counters.entries()].sort()) {
    const [method, status] = key.split(':');
    lines.push(`homelabrrr_http_requests_total{method="${method}",status="${status}"} ${count}`);
  }
  for (const [method, value] of [...durations.entries()].sort()) {
    lines.push(`homelabrrr_http_request_duration_ms_sum{method="${method}"} ${value.sum}`);
    lines.push(`homelabrrr_http_request_duration_ms_count{method="${method}"} ${value.count}`);
  }
  for (const [key, count] of metricEvents().sort()) {
    const separator = key.indexOf(':');
    const name = safeLabel(key.slice(0, separator));
    const labels = key.slice(separator + 1);
    lines.push(`homelabrrr_${name}_total${labels ? `{${labels}}` : ''} ${count}`);
  }
  lines.push(`homelabrrr_websocket_connections{kind="vnc"} ${Number(vncWebSockets) || 0}`);
  lines.push(`homelabrrr_websocket_connections{kind="ssh"} ${Number(sshWebSockets) || 0}`);
  try {
    const pageCount = db.pragma('page_count', { simple: true });
    const pageSize = db.pragma('page_size', { simple: true });
    lines.push(`homelabrrr_sqlite_bytes ${Number(pageCount) * Number(pageSize)}`);
    const freelist = db.pragma('freelist_count', { simple: true });
    lines.push(`homelabrrr_sqlite_reclaimable_bytes ${Number(freelist) * Number(pageSize)}`);
    let walBytes = 0;
    try { walBytes = statSync(`${db.name}-wal`).size; } catch { /* no WAL file yet */ }
    lines.push(`homelabrrr_sqlite_wal_bytes ${walBytes}`);
    for (const [table, type] of [['provisioned_vms', 'provision'], ['vm_migrations', 'migration']]) {
      const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all();
      for (const row of rows) {
        lines.push(`homelabrrr_jobs{type="${type}",status="${safeLabel(row.status)}"} ${row.count}`);
      }
    }
  } catch { /* readiness reports database failures */ }
  return `${lines.join('\n')}\n`;
}
