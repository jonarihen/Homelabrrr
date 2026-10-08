import { and, eq, gte, lte, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { hardwareConnections, hardwarePowerSamples, hardwareEnergyIntervals, hardwareTelemetryState } from '../db/schema/index.ts';
import { decryptSecret } from '../utils/secrets.ts';
import { discoverHardware, IloError, physicalSystemIdentity, type HardwareHealth } from './iloAdapter.ts';
import { integrateWattSamples } from './energyIntervals.ts';
import { startBackgroundWork } from './backgroundWork.ts';
import { log } from '../utils/logger.ts';

const parsedInterval = Number(process.env.HARDWARE_POLL_INTERVAL_MS || 60_000);
export const HARDWARE_POLL_INTERVAL_MS = Number.isInteger(parsedInterval) && parsedInterval >= 30_000 ? parsedInterval : 60_000;
const LEASE_MS = 120_000;
let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let sweepRunning = false;

export function validateInstantaneousWatts(watts: unknown, observedAt: unknown, now = new Date()): { watts: number; observedAt: Date } {
  const date = new Date(String(observedAt));
  if (typeof watts !== 'number' || !Number.isFinite(watts) || watts < 0 || watts > 100_000 || !Number.isFinite(date.getTime()) || date.getTime() > now.getTime() + 5000 || date.getTime() < now.getTime() - 120_000) {
    throw new Error('INVALID_HARDWARE_SAMPLE');
  }
  return { watts, observedAt: date };
}

export function aggregationLookbackStart(observedAt: Date): Date {
  const currentBucketStart = Math.floor(observedAt.getTime() / (15 * 60_000)) * (15 * 60_000);
  return new Date(currentBucketStart - 15 * 60_000);
}

export function aggregationLookaheadEnd(observedAt: Date): Date {
  const currentBucketStart = Math.floor(observedAt.getTime() / (15 * 60_000)) * (15 * 60_000);
  return new Date(currentBucketStart + 30 * 60_000);
}

// Keep vendor payloads out of the database even if a future reader accidentally
// returns extra fields. A malformed optional snapshot never discards good watts.
export function healthForStorage(input: HardwareHealth | undefined): HardwareHealth | null {
  if (!input || !Array.isArray(input.temperatures) || !Array.isArray(input.fans) || !Array.isArray(input.powerSupplies)) return null;
  const name = (value: unknown) => typeof value === 'string' ? value.slice(0, 64) : '';
  const status = (value: unknown) => typeof value === 'string' && value.length <= 32 ? value : null;
  const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
  return {
    temperatures: input.temperatures.slice(0, 64).map((item) => ({ name: name(item?.name), celsius: number(item?.celsius, -40, 125), health: status(item?.health) })),
    fans: input.fans.slice(0, 32).map((item) => { const unit = item?.unit === 'percent' || item?.unit === 'rpm' ? item.unit : null;
      return { name: name(item?.name), value: unit ? number(item?.value, 0, unit === 'percent' ? 100 : 50_000) : null, unit, health: status(item?.health) }; }),
    powerSupplies: input.powerSupplies.slice(0, 16).map((item) => ({ name: name(item?.name), health: status(item?.health), state: status(item?.state) })),
    powerRedundancy: input.powerRedundancy ? { health: status(input.powerRedundancy.health), state: status(input.powerRedundancy.state) } : null,
    limited: Boolean(input.limited) || input.temperatures.length > 64 || input.fans.length > 32 || input.powerSupplies.length > 16,
  };
}

export async function pollHardwareConnection(id: number, now = () => new Date(), reader = discoverHardware) {
  const current = now();
  const lease = new Date(current.getTime() + LEASE_MS);
  const claimed = await db.execute(sql`
    INSERT INTO hardware_telemetry_state (hardware_id, lease_until, next_poll_at, last_attempt_at)
    VALUES (${id}, ${lease}, ${lease}, ${current})
    ON CONFLICT (hardware_id) DO UPDATE SET lease_until = EXCLUDED.lease_until,
      next_poll_at = EXCLUDED.next_poll_at, last_attempt_at = EXCLUDED.last_attempt_at
    WHERE (hardware_telemetry_state.lease_until IS NULL OR hardware_telemetry_state.lease_until <= ${current})
      AND hardware_telemetry_state.next_poll_at <= ${current}
    RETURNING hardware_id
  `);
  if (!claimed.rows.length) return { status: 'skipped' as const };
  return startBackgroundWork(async () => {
    const [connection] = await db.select().from(hardwareConnections).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'), eq(hardwareConnections.collection_enabled, true))).limit(1);
    if (!connection || !connection.system_uuid) {
      await db.update(hardwareTelemetryState).set({ lease_until: null }).where(and(eq(hardwareTelemetryState.hardware_id, id), eq(hardwareTelemetryState.lease_until, lease)));
      return { status: 'disabled' as const };
    }
    try {
      const sample = await reader({ host: connection.target_host, port: connection.target_port, username: connection.username, password: decryptSecret(connection.secret), verifyTls: connection.verify_tls, caCertificate: connection.ca_certificate });
      // A changed physical identity must never silently extend the old energy series.
      const identity = physicalSystemIdentity(sample.identity);
      if (identity !== connection.system_uuid.trim().toLowerCase()) throw new Error('HARDWARE_IDENTITY_CHANGED');
      const measurement = validateInstantaneousWatts(sample.sample.watts, sample.sample.observedAt, now());
      if (!sample.sample.origin || sample.sample.unit !== 'W') throw new Error('INVALID_HARDWARE_SAMPLE');
      const origin = sample.sample.origin;
      await db.transaction(async (tx) => {
        const [fresh] = await tx.select({ config_version: hardwareConnections.config_version }).from(hardwareConnections).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'), eq(hardwareConnections.collection_enabled, true))).limit(1);
        const [state] = await tx.select({ lease_until: hardwareTelemetryState.lease_until }).from(hardwareTelemetryState).where(eq(hardwareTelemetryState.hardware_id, id)).limit(1);
        if (!fresh || fresh.config_version !== connection.config_version || state?.lease_until?.getTime() !== lease.getTime()) return;
        await tx.insert(hardwarePowerSamples).values({ hardware_id: id, node_ref: connection.node_ref, observed_at: measurement.observedAt, watts: String(measurement.watts), mode: sample.mode.value, origin, device_epoch: connection.system_uuid, health: healthForStorage(sample.sample.health) }).onConflictDoNothing();
        // Always include the full preceding bucket. A sliding 20-minute
        // lookback would later recompute an older bucket without its first
        // sample and overwrite a complete aggregate with partial energy.
        const since = aggregationLookbackStart(measurement.observedAt);
        // An out-of-order observation can alter energy between itself and an
        // already stored later sample. Recompute through that later sample.
        const through = aggregationLookaheadEnd(measurement.observedAt);
        const recent = await tx.select().from(hardwarePowerSamples).where(and(eq(hardwarePowerSamples.hardware_id, id), gte(hardwarePowerSamples.observed_at, since), lte(hardwarePowerSamples.observed_at, through))).orderBy(hardwarePowerSamples.observed_at);
        const intervals = integrateWattSamples(recent.map((row) => ({ hardwareId: id, observedAt: row.observed_at, watts: Number(row.watts), deviceEpoch: row.device_epoch })), { intervalMs: HARDWARE_POLL_INTERVAL_MS });
        for (const interval of intervals) {
          await tx.insert(hardwareEnergyIntervals).values({ hardware_id: id, start_utc: interval.startUtc, end_utc: interval.endUtc, kwh: interval.kwh, covered_seconds: Math.round(interval.coveredSeconds), expected_seconds: interval.expectedSeconds, quality: interval.quality, method_version: interval.methodVersion })
            .onConflictDoUpdate({ target: [hardwareEnergyIntervals.hardware_id, hardwareEnergyIntervals.start_utc], set: { kwh: interval.kwh, covered_seconds: Math.round(interval.coveredSeconds), quality: interval.quality, updated_at: now() } });
        }
        await tx.update(hardwareTelemetryState).set({ lease_until: null, next_poll_at: new Date(now().getTime() + HARDWARE_POLL_INTERVAL_MS), failure_count: 0, last_error_code: null, last_success_at: measurement.observedAt }).where(eq(hardwareTelemetryState.hardware_id, id));
      });
      return { status: 'ok' as const };
    } catch (err) {
      const [state] = await db.select({ failure_count: hardwareTelemetryState.failure_count }).from(hardwareTelemetryState).where(eq(hardwareTelemetryState.hardware_id, id)).limit(1);
      const failures = Math.min(6, (state?.failure_count || 0) + 1);
      const next = new Date(now().getTime() + Math.min(30 * 60_000, HARDWARE_POLL_INTERVAL_MS * 2 ** failures) + Math.floor(Math.random() * 5000));
      const code = err instanceof IloError ? err.code : err instanceof Error && /^(INVALID_HARDWARE_SAMPLE|HARDWARE_IDENTITY_CHANGED)$/.test(err.message) ? err.message : 'COLLECTION_FAILED';
      await db.update(hardwareTelemetryState).set({ lease_until: null, next_poll_at: next, failure_count: failures, last_error_code: code }).where(and(eq(hardwareTelemetryState.hardware_id, id), eq(hardwareTelemetryState.lease_until, lease)));
      log('warn', 'hardware_telemetry_poll_failed', { hardwareId: id, code });
      return { status: 'failed' as const, code };
    }
  }, { kind: 'hardware-telemetry', hardwareId: id });
}

export async function sweepHardwareTelemetry() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const rows = await db.select({ id: hardwareConnections.id }).from(hardwareConnections).where(and(eq(hardwareConnections.lifecycle_state, 'active'), eq(hardwareConnections.collection_enabled, true)));
    for (let i = 0; i < rows.length; i += 2) await Promise.allSettled(rows.slice(i, i + 2).map((row) => pollHardwareConnection(row.id)));
  } finally { sweepRunning = false; }
}
export function startHardwareTelemetry() {
  if (timer) return;
  initialTimer = setTimeout(() => { void sweepHardwareTelemetry().catch((err) => log('warn', 'hardware_telemetry_sweep_failed', { error: err })); }, 10_000);
  timer = setInterval(() => { void sweepHardwareTelemetry().catch((err) => log('warn', 'hardware_telemetry_sweep_failed', { error: err })); }, HARDWARE_POLL_INTERVAL_MS);
  initialTimer.unref(); timer.unref();
}
export function stopHardwareTelemetry() {
  if (initialTimer) clearTimeout(initialTimer);
  if (timer) clearInterval(timer);
  initialTimer = null; timer = null;
}

export async function latestHardwareSample(id: number) {
  const [sample] = await db.select().from(hardwarePowerSamples).where(eq(hardwarePowerSamples.hardware_id, id)).orderBy(desc(hardwarePowerSamples.observed_at)).limit(1);
  return sample || null;
}

// Recompute completed Copenhagen days from 15-minute buckets before pruning.
// Daily rows preserve coverage and DST-aware expected duration for five years.
export async function runHardwareTelemetryRetention(now = new Date()) {
  const rawCutoff = new Date(now.getTime() - 30 * 86400_000);
  const intervalCutoff = new Date(now.getTime() - 730 * 86400_000);
  const dayCutoff = new Date(now.getTime() - 1826 * 86400_000);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO hardware_energy_days (hardware_id, local_date, kwh, covered_seconds, expected_seconds, quality, method_version)
      WITH local_intervals AS (
        SELECT hardware_id, (start_utc AT TIME ZONE 'Europe/Copenhagen')::date AS local_date, kwh, covered_seconds
        FROM hardware_energy_intervals
        WHERE start_utc < (date_trunc('day', ${now}::timestamptz AT TIME ZONE 'Europe/Copenhagen') AT TIME ZONE 'Europe/Copenhagen')
      )
      SELECT hardware_id, local_date, sum(kwh), sum(covered_seconds),
        extract(epoch FROM ((local_date + 1) AT TIME ZONE 'Europe/Copenhagen') - (local_date AT TIME ZONE 'Europe/Copenhagen'))::integer,
        CASE WHEN sum(covered_seconds) = extract(epoch FROM ((local_date + 1) AT TIME ZONE 'Europe/Copenhagen') - (local_date AT TIME ZONE 'Europe/Copenhagen'))::integer
          THEN 'integrated_complete' ELSE 'integrated_partial' END,
        'trapezoid_v1'
      FROM local_intervals GROUP BY hardware_id, local_date
      ON CONFLICT (hardware_id, local_date) DO UPDATE SET kwh = EXCLUDED.kwh,
        covered_seconds = EXCLUDED.covered_seconds, expected_seconds = EXCLUDED.expected_seconds,
        quality = EXCLUDED.quality, method_version = EXCLUDED.method_version
    `);
    const raw = await tx.execute(sql`DELETE FROM hardware_power_samples WHERE observed_at < ${rawCutoff}`);
    const intervals = await tx.execute(sql`DELETE FROM hardware_energy_intervals WHERE start_utc < ${intervalCutoff}
      AND EXISTS (SELECT 1 FROM hardware_energy_days WHERE hardware_energy_days.hardware_id = hardware_energy_intervals.hardware_id
        AND hardware_energy_days.local_date = (hardware_energy_intervals.start_utc AT TIME ZONE 'Europe/Copenhagen')::date)`);
    const days = await tx.execute(sql`DELETE FROM hardware_energy_days WHERE local_date < (${dayCutoff}::timestamptz AT TIME ZONE 'Europe/Copenhagen')::date`);
    return { rawDeleted: raw.rowCount || 0, intervalsDeleted: intervals.rowCount || 0, daysDeleted: days.rowCount || 0 };
  });
}
