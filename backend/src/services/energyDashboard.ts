import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { HARDWARE_POLL_INTERVAL_MS } from './hardwareTelemetry.ts';

export function parseEnergyMonth(value: unknown, now = new Date()): string {
  const month = value === undefined ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(now) : value;
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('INVALID_MONTH');
  return month;
}

export function parseHistoryRange(value: unknown): '24h' | '7d' {
  if (value === undefined || value === '24h') return '24h';
  if (value === '7d') return '7d';
  throw new Error('INVALID_RANGE');
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

type HostRow = { id: number; watts: string | null; mode: string | null; observed_at: Date | null; collection_enabled: boolean; last_error_code: string | null };

export function safeHosts(rows: HostRow[], now: Date) {
  const staleAfterMs = 3 * HARDWARE_POLL_INTERVAL_MS;
  return rows.map((row, index) => {
    const ageSeconds = row.observed_at ? Math.max(0, Math.floor((now.getTime() - new Date(row.observed_at).getTime()) / 1000)) : null;
    const stale = ageSeconds === null || ageSeconds * 1000 > staleAfterMs;
    return { alias: `Server ${String(index + 1).padStart(2, '0')}`, watts: numberOrNull(row.watts), observedAt: row.observed_at,
      ageSeconds, stale, observedMode: row.mode, monitoring: row.collection_enabled ? row.last_error_code ? 'degraded' : 'enabled' : 'disabled' };
  });
}

export async function energyHosts(now = new Date()) {
  const result = await db.execute(sql`
    SELECT c.id, c.collection_enabled, s.watts, s.mode, s.observed_at, t.last_error_code
    FROM hardware_connections c
    LEFT JOIN LATERAL (
      SELECT watts, mode, observed_at FROM hardware_power_samples
      WHERE hardware_id = c.id ORDER BY observed_at DESC LIMIT 1
    ) s ON true
    LEFT JOIN hardware_telemetry_state t ON t.hardware_id = c.id
    WHERE c.lifecycle_state = 'active' ORDER BY c.id
  `);
  return { status: result.rows.length ? 'available' : 'unconfigured', hosts: safeHosts(result.rows as HostRow[], now) };
}

export async function energySummary(month: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const firstDay = `${month}-01`;
    const bounds = await tx.execute(sql`
      SELECT (${firstDay}::date::timestamp AT TIME ZONE 'Europe/Copenhagen') AS start_at,
        ((${firstDay}::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'Europe/Copenhagen') AS end_at
    `);
    const { start_at: startAt, end_at: endAt } = bounds.rows[0] as { start_at: Date; end_at: Date };
    const coveredTo = now < startAt ? startAt : now < endAt ? now : endAt;
    const hostRows = await tx.execute(sql`
      SELECT c.id, c.collection_enabled, s.watts, s.mode, s.observed_at, t.last_error_code
      FROM hardware_connections c
      LEFT JOIN LATERAL (
        SELECT watts, mode, observed_at FROM hardware_power_samples
        WHERE hardware_id = c.id ORDER BY observed_at DESC LIMIT 1
      ) s ON true
      LEFT JOIN hardware_telemetry_state t ON t.hardware_id = c.id
      WHERE c.lifecycle_state = 'active' ORDER BY c.id
    `);
    const hosts = safeHosts(hostRows.rows as HostRow[], now);
    const energy = await tx.execute(sql`
      SELECT sum(i.kwh)::text AS kwh, sum(i.covered_seconds)::integer AS covered_seconds,
        sum(i.expected_seconds)::integer AS expected_seconds, max(i.updated_at) AS revised_at
      FROM hardware_energy_intervals i JOIN hardware_connections c ON c.id = i.hardware_id
      WHERE c.lifecycle_state = 'active' AND i.start_utc >= ${startAt} AND i.end_utc <= ${coveredTo}
    `);
    const row = energy.rows[0] as { kwh: string | null; covered_seconds: number | null; expected_seconds: number | null; revised_at: Date | null };
    const fresh = hosts.filter((host) => host.monitoring !== 'disabled' && !host.stale && host.watts !== null);
    const watts = fresh.length ? fresh.reduce((sum, host) => sum + host.watts!, 0) : null;
    const kwh = numberOrNull(row.kwh);
    const possibleSeconds = Math.max(0, (coveredTo.getTime() - startAt.getTime()) / 1000) * hosts.length;
    const coveragePercent = possibleSeconds > 0 && row.covered_seconds !== null ?
      Math.min(100, Math.max(0, row.covered_seconds / possibleSeconds * 100)) : null;
    return {
      month, period: { startAt, endAt, throughAt: coveredTo, timeZone: 'Europe/Copenhagen' },
      telemetry: { status: !hosts.length ? 'unconfigured' : !fresh.length ? 'unavailable' : fresh.length < hosts.length ? 'partial' : 'measured',
        watts, observedAt: fresh.length ? fresh.reduce((latest, host) => !latest || new Date(host.observedAt!) < new Date(latest) ? host.observedAt : latest, null as Date | null) : null,
        monitoredHosts: fresh.length, configuredHosts: hosts.length, kwh, coveragePercent, revisedAt: row.revised_at,
        energyStatus: kwh === null ? 'unavailable' : coveragePercent === 100 ? 'measured' : 'partial' },
      price: { status: 'unavailable', orePerKwh: null, basis: null, validUntil: null },
      cost: { status: 'unavailable', actualOre: null, forecastOre: null, components: [] },
      funding: { status: 'unavailable', grossOre: null, feeDebitsOre: null, feeCreditsOre: null,
        refundDebitsOre: null, knownNetOre: null, eligibleNetOre: null, appliedOre: null,
        ownerFundedOre: null, carryForwardOre: null, unresolvedOre: null, reconciledAt: null },
    };
  }, { isolationLevel: 'repeatable read' });
}

export async function energyHistory(range: '24h' | '7d', now = new Date()) {
  const start = new Date(now.getTime() - (range === '24h' ? 24 : 168) * 3_600_000);
  const binSeconds = range === '24h' ? 3600 : 7200;
  const result = await db.execute(sql`
    WITH per_host AS (
      SELECT s.hardware_id, to_timestamp(floor(extract(epoch FROM s.observed_at) / ${binSeconds}) * ${binSeconds}) AS at,
        avg(s.watts) AS watts
      FROM hardware_power_samples s JOIN hardware_connections c ON c.id = s.hardware_id
      WHERE c.lifecycle_state = 'active' AND s.observed_at >= ${start} AND s.observed_at <= ${now}
      GROUP BY s.hardware_id, at
    )
    SELECT at, sum(watts)::text AS watts, count(*)::integer AS measured_hosts
    FROM per_host GROUP BY at ORDER BY at LIMIT 100
  `);
  return { range, from: start, through: now, unit: 'W', points: result.rows.map((row: any) =>
    ({ at: row.at, watts: numberOrNull(row.watts), measuredHosts: row.measured_hosts })) };
}
