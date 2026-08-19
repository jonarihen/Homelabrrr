import type { Request, Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client.ts';
import { log } from './logger.ts';
import { metricEvents } from './metricRegistry.ts';

const startedAt = Date.now();
const counters = new Map<string, number>();
const durations = new Map<string, { count: number; sum: number }>();
function keyFor(method: string, status: number) {
  return `${method}:${status}`;
}

export function observeRequests(req: Request, res: Response, next: NextFunction): void {
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
      requestId: (req as Request & { requestId?: string }).requestId,
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      actor: req.session?.username || 'anonymous',
      authType: (req as Request & { apiToken?: unknown }).apiToken ? 'api_token' : req.session?.userId ? 'session' : 'none',
    });
  });
  next();
}

export function liveness(): { ok: boolean; uptimeSeconds: number } {
  return { ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) };
}

export async function readiness(): Promise<{ ok: boolean; database: string; schemaVersion?: number; error?: string }> {
  try {
    // Bounded so a wedged database turns into a 503 instead of a hung probe.
    const result = await Promise.race([
      db.execute(sql`SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref?.()),
    ]);
    const version = Number((result.rows[0] as { version: number | string }).version);
    return { ok: true, database: 'ok', schemaVersion: version };
  } catch {
    // Readiness is intentionally unauthenticated for container orchestrators;
    // never reflect connection strings, SQL text, or other internal detail.
    return { ok: false, database: 'unavailable', error: 'Database readiness check failed' };
  }
}

function safeLabel(value: unknown): string {
  return String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
}

export async function metricsText({ vncWebSockets = 0, sshWebSockets = 0 } = {}): Promise<string> {
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
  // Connection-pool pressure: waiting > 0 sustained means the pool is too small
  // or a query is stuck.
  lines.push(`homelabrrr_pg_pool_clients{state="total"} ${pool.totalCount}`);
  lines.push(`homelabrrr_pg_pool_clients{state="idle"} ${pool.idleCount}`);
  lines.push(`homelabrrr_pg_pool_clients{state="waiting"} ${pool.waitingCount}`);
  try {
    const size = await db.execute(sql`SELECT pg_database_size(current_database()) AS bytes`);
    lines.push(`homelabrrr_pg_database_bytes ${Number((size.rows[0] as { bytes: number | string }).bytes)}`);
    for (const [table, type] of [['provisioned_vms', 'provision'], ['vm_migrations', 'migration']] as const) {
      const rows = await db.execute(sql`SELECT status, COUNT(*) AS count FROM ${sql.identifier(table)} GROUP BY status`);
      for (const row of rows.rows as { status: string; count: number | string }[]) {
        lines.push(`homelabrrr_jobs{type="${type}",status="${safeLabel(row.status)}"} ${Number(row.count)}`);
      }
    }
  } catch { /* readiness reports database failures */ }
  return `${lines.join('\n')}\n`;
}
