import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { eloverblikConnections, eloverblikIntervals, eloverblikChargeSnapshots, eloverblikChargeObservations } from '../db/schema/index.ts';
import { encryptSecret, decryptSecret } from '../utils/secrets.ts';
import { eloverblikClient, ElOverblikClient, ElOverblikError } from './eloverblikClient.ts';
import { normalizeMeterSeries } from './eloverblikNormalize.ts';
import { startBackgroundWork } from './backgroundWork.ts';
import { log } from '../utils/logger.ts';
import { notify, portalLink } from '../utils/notify.ts';

const ID = 1;
let running: Promise<unknown> | null = null;
let timer: NodeJS.Timeout | null = null;
let schedulerActive = false;
const NORMAL_SYNC_MS = 6 * 60 * 60_000;
const BACKFILL_STEP_MS = 60_000;
const FAILURE_RETRY_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 12 * 60 * 60_000;
const MANUAL_COOLDOWN_MS = 5 * 60_000;
const CHUNK_DAYS = 30;
const BACKFILL_DAYS = 395;
const CHUNK_SKIP_AFTER = 3;
const MAX_SKIPPED_RANGES = 100;
const MANUAL_PERIOD_MAX_DAYS = 31;
const MANUAL_PERIOD_HISTORY_DAYS = 3 * 366;
// These stop periodic polling until the owner reconnects or reselects a meter.
const ATTENTION_CODES = new Set(['RECONNECT_REQUIRED', 'METER_UNAUTHORIZED', 'METER_MISSING']);
// Failures that say nothing about the requested period; never skip a chunk for them.
const NON_SKIPPABLE = new Set([...ATTENTION_CODES, 'RATE_LIMITED', 'CONFIG_CHANGED', 'NETWORK']);
const RESET_PROGRESS = { import_cursor: null, last_success_at: null, latest_interval_end: null, skipped_ranges: [],
  consecutive_failures: 0, next_attempt_at: null, retry_after_until: null, failing_chunk_start: null, chunk_failures: 0,
  attention_code: null, attention_since: null, last_error_code: null };

export type SkippedRange = { from: string; to: string; code: string; skippedAt: string };

async function connection() {
  const [row] = await db.select().from(eloverblikConnections).where(eq(eloverblikConnections.id, ID)).limit(1);
  return row;
}
function skippedRanges(value: unknown): SkippedRange[] { return Array.isArray(value) ? value as SkippedRange[] : []; }

// Admin-only status. The meter ID is masked; time series are never returned.
export async function energyDataStatus() {
  const row = await connection();
  if (!row) return { configured: false, enabled: false, selectedMeter: null, scope: 'household' };
  const meter = row.selected_meter_id;
  const coverage = meter ? (await db.execute(sql`
    SELECT min(interval_start) AS earliest, max(interval_end) AS latest, count(*)::int AS intervals,
      count(*) FILTER (WHERE energy_kwh IS NULL)::int AS unknown_values
    FROM eloverblik_intervals WHERE meter_id = ${meter}`)).rows[0] as { earliest: Date | null; latest: Date | null; intervals: number; unknown_values: number } : null;
  // Holes between consecutive stored intervals of one series (most recent first, bounded).
  const gaps = meter ? (await db.execute(sql`
    SELECT gap_start, gap_end FROM (
      SELECT interval_end AS gap_start, lead(interval_start) OVER (PARTITION BY series_key ORDER BY interval_start) AS gap_end
      FROM eloverblik_intervals WHERE meter_id = ${meter}
    ) g WHERE gap_end > gap_start ORDER BY gap_start DESC LIMIT 20`)).rows as Array<{ gap_start: Date; gap_end: Date }> : [];
  const [charges] = meter ? await db.select({ last_observed_at: sql<Date | null>`max(${eloverblikChargeObservations.last_observed_at})`, versions: sql<number>`count(DISTINCT ${eloverblikChargeObservations.snapshot_id})::int` })
    .from(eloverblikChargeObservations).where(eq(eloverblikChargeObservations.meter_id, meter)) : [];
  return { configured: Boolean(row.refresh_token), enabled: row.enabled, selectedMeter: meter ? `••••${meter.slice(-4)}` : null,
    scope: row.meter_scope, lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, latestIntervalEnd: row.latest_interval_end, lastErrorCode: row.last_error_code,
    attention: row.attention_code ? { code: row.attention_code, since: row.attention_since } : null,
    retry: { consecutiveFailures: row.consecutive_failures, nextAttemptAt: row.next_attempt_at, retryAfterUntil: row.retry_after_until },
    backfill: { inProgress: Boolean(row.import_cursor) || (Boolean(meter) && !row.last_success_at), cursor: row.import_cursor },
    coverage: coverage ? { earliestIntervalStart: coverage.earliest, latestIntervalEnd: coverage.latest, intervals: coverage.intervals, unknownValues: coverage.unknown_values } : null,
    gaps: gaps.map((gap) => ({ from: gap.gap_start, to: gap.gap_end })),
    skippedRanges: skippedRanges(row.skipped_ranges),
    charges: meter ? { available: Boolean(charges?.last_observed_at), lastObservedAt: charges?.last_observed_at ?? null, observedVersions: charges?.versions ?? 0 } : null };
}
export async function saveRefreshToken(raw: string) {
  if (!raw || raw.length > 8192) throw new ElOverblikError('INVALID_TOKEN');
  // Prove the token can list linked meters before replacing durable configuration.
  await new ElOverblikClient().listMeters(raw);
  const previous = await connection();
  const encrypted = encryptSecret(raw);
  await db.insert(eloverblikConnections).values({ id: ID, refresh_token: encrypted, enabled: false, selected_meter_id: null, meter_scope: 'household', config_version: 1 })
    .onConflictDoUpdate({ target: eloverblikConnections.id, set: { refresh_token: encrypted, enabled: false, selected_meter_id: null,
      meter_scope: 'household', config_version: (previous?.config_version ?? 0) + 1, ...RESET_PROGRESS } });
  eloverblikClient.invalidate();
  if (schedulerActive) scheduleNext(1_000);
}
export async function listAvailableMeters() {
  const row = await connection();
  if (!row?.refresh_token) throw new ElOverblikError('NOT_CONFIGURED');
  return eloverblikClient.listMeters(decryptSecret(row.refresh_token)!);
}
export async function selectMeter(meterId: string, scope: 'household' | 'dedicated_lab') {
  if (typeof meterId !== 'string' || !/^\d{18}$/.test(meterId) || !['household', 'dedicated_lab'].includes(scope)) throw new ElOverblikError('INVALID_REQUEST');
  const row = await connection();
  if (!row?.refresh_token) throw new ElOverblikError('NOT_CONFIGURED');
  const meters = await listAvailableMeters();
  if (!meters.some((meter) => meter.id === meterId && meter.hasRelation)) throw new ElOverblikError('METER_UNAUTHORIZED');
  // A different meter starts its own full backfill; its coverage, cursor and
  // gaps are never inherited from the previous meter. Re-selecting the same
  // meter (e.g. after restoring its authorization) keeps progress.
  const progress = meterId === row.selected_meter_id
    ? { consecutive_failures: 0, next_attempt_at: null, failing_chunk_start: null, chunk_failures: 0, attention_code: null, attention_since: null, last_error_code: null }
    : RESET_PROGRESS;
  await db.update(eloverblikConnections).set({ selected_meter_id: meterId, meter_scope: scope, enabled: true,
    config_version: row.config_version + 1, ...progress }).where(and(eq(eloverblikConnections.id, ID), eq(eloverblikConnections.config_version, row.config_version)));
  eloverblikClient.invalidate();
  if (schedulerActive) scheduleNext(1_000);
}
// Disconnect stops all further token use. Retained history is purged only on
// explicit request.
export async function disconnect({ purgeHistory = false }: { purgeHistory?: boolean } = {}) {
  const row = await connection();
  if (!row) return { purged: false };
  await db.transaction(async (tx) => {
    await tx.update(eloverblikConnections).set({ refresh_token: null, enabled: false, selected_meter_id: null,
      config_version: row.config_version + 1, ...RESET_PROGRESS }).where(eq(eloverblikConnections.id, ID));
    if (purgeHistory) {
      await tx.delete(eloverblikChargeObservations);
      await tx.delete(eloverblikChargeSnapshots);
      await tx.delete(eloverblikIntervals);
    }
  });
  eloverblikClient.invalidate();
  return { purged: purgeHistory };
}
function isoDay(date: Date) { return date.toISOString().slice(0, 10); }
function utcDay(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); }

async function recordCharges(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], meterId: string, charges: Record<string, any> | null, now: Date) {
  if (!charges || !Array.isArray(charges.result)) return;
  const own = charges.result.filter((part: any) => part?.id === meterId);
  if (own.length !== 1 || own[0].success !== true) return;
  const payload = own[0].result ?? own[0];
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const [inserted] = await tx.insert(eloverblikChargeSnapshots).values({ meter_id: meterId, content_hash: hash, source_payload: payload, observed_at: now })
    .onConflictDoNothing().returning({ id: eloverblikChargeSnapshots.id });
  const snapshotId = inserted?.id ?? (await tx.select({ id: eloverblikChargeSnapshots.id }).from(eloverblikChargeSnapshots)
    .where(and(eq(eloverblikChargeSnapshots.meter_id, meterId), eq(eloverblikChargeSnapshots.content_hash, hash))).limit(1))[0].id;
  const [latest] = await tx.select().from(eloverblikChargeObservations).where(eq(eloverblikChargeObservations.meter_id, meterId))
    .orderBy(desc(eloverblikChargeObservations.first_observed_at), desc(eloverblikChargeObservations.id)).limit(1);
  if (latest?.snapshot_id === snapshotId) {
    if (now > latest.last_observed_at) await tx.update(eloverblikChargeObservations).set({ last_observed_at: now }).where(eq(eloverblikChargeObservations.id, latest.id));
  } else {
    await tx.insert(eloverblikChargeObservations).values({ meter_id: meterId, snapshot_id: snapshotId, first_observed_at: now, last_observed_at: now });
  }
}

export interface SyncOptions { client?: ElOverblikClient; manual?: boolean; period?: { from: Date; to: Date } | null }

export async function syncSelectedMeter(now = new Date(), { client = eloverblikClient, manual = false, period = null }: SyncOptions = {}) {
  if (running) return running;
  const work = startBackgroundWork(async () => {
    const initial = await connection();
    if (!initial?.enabled || !initial.refresh_token || !initial.selected_meter_id) return { status: 'disabled' };
    if (initial.attention_code) return { status: 'attention_required', code: initial.attention_code };
    if (initial.retry_after_until && initial.retry_after_until > now) {
      if (manual) throw new ElOverblikError('RATE_LIMITED', initial.retry_after_until.getTime() - now.getTime());
      return { status: 'deferred', retryAt: initial.retry_after_until };
    }
    if (!manual && initial.next_attempt_at && initial.next_attempt_at > now) return { status: 'deferred', retryAt: initial.next_attempt_at };
    const version = initial.config_version;
    const meterId = initial.selected_meter_id;
    const refresh = decryptSecret(initial.refresh_token)!;
    const end = utcDay(now);
    const backfill = !period && (Boolean(initial.import_cursor) || !initial.last_success_at);
    const start = period ? period.from : initial.import_cursor ? initial.import_cursor
      : initial.last_success_at ? new Date(end.getTime() - 7 * 86_400_000) : new Date(end.getTime() - BACKFILL_DAYS * 86_400_000);
    const chunkEnd = period ? period.to : new Date(Math.min(end.getTime(), start.getTime() + CHUNK_DAYS * 86_400_000));
    if (chunkEnd <= start) return { status: 'current' };
    const nextCursor = period ? initial.import_cursor : chunkEnd < end ? chunkEnd : null;
    await db.update(eloverblikConnections).set({ last_attempt_at: now }).where(eq(eloverblikConnections.id, ID));
    try {
      const response = await client.timeSeries(refresh, meterId, isoDay(start), isoDay(chunkEnd));
      const intervals = normalizeMeterSeries(response, meterId, now);
      // Charges are optional: their absence/failure never blocks consumption.
      const charges = await client.charges(refresh, meterId).catch(() => null);
      const current = await connection();
      if (current?.config_version !== version || current.selected_meter_id !== meterId || !current.enabled) throw new ElOverblikError('CONFIG_CHANGED');
      await db.transaction(async (tx) => {
        // Serialize against concurrent configuration changes; version checked again inside transaction.
        const [locked] = await tx.select().from(eloverblikConnections).where(eq(eloverblikConnections.id, ID)).for('update');
        if (locked.config_version !== version || !locked.enabled || locked.selected_meter_id !== meterId) throw new ElOverblikError('CONFIG_CHANGED');
        for (const value of intervals) await tx.insert(eloverblikIntervals).values(value).onConflictDoUpdate({
          target: [eloverblikIntervals.meter_id, eloverblikIntervals.series_key, eloverblikIntervals.aggregation, eloverblikIntervals.interval_start, eloverblikIntervals.interval_end],
          set: { energy_kwh: value.energy_kwh, quality: value.quality, fetched_at: now },
        });
        await recordCharges(tx, meterId, charges, now);
        const latest = intervals.reduce<Date | null>((value, item) => !value || item.interval_end > value ? item.interval_end : value, null);
        // A successful re-import of a skipped range closes that recorded gap.
        const remaining = skippedRanges(locked.skipped_ranges).filter((range) => !(Date.parse(range.from) >= start.getTime() && Date.parse(range.to) <= chunkEnd.getTime()));
        await tx.update(eloverblikConnections).set({ last_success_at: now,
          latest_interval_end: latest && (!locked.latest_interval_end || latest > locked.latest_interval_end) ? latest : locked.latest_interval_end,
          import_cursor: nextCursor, last_error_code: null, consecutive_failures: 0, next_attempt_at: null, retry_after_until: null,
          failing_chunk_start: null, chunk_failures: 0, skipped_ranges: remaining }).where(eq(eloverblikConnections.id, ID));
      });
      return { status: 'ok', count: intervals.length, nextCursor };
    } catch (err) {
      const code = err instanceof ElOverblikError ? err.code : 'SYNC_FAILED';
      if (code === 'CONFIG_CHANGED') throw err;
      const retryAfterMs = err instanceof ElOverblikError ? err.retryAfterMs : null;
      const failures = initial.consecutive_failures + 1;
      const backoff = Math.min(FAILURE_RETRY_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);
      const nextAttempt = new Date(now.getTime() + Math.max(backoff, retryAfterMs ?? 0));
      const chunkFailures = initial.failing_chunk_start?.getTime() === start.getTime() ? initial.chunk_failures + 1 : 1;
      const attention = ATTENTION_CODES.has(code);
      const skip = backfill && !NON_SKIPPABLE.has(code) && chunkFailures >= CHUNK_SKIP_AFTER;
      const retryState = { last_error_code: code, retry_after_until: retryAfterMs ? new Date(now.getTime() + retryAfterMs) : initial.retry_after_until };
      if (skip) {
        const ranges = [...skippedRanges(initial.skipped_ranges).filter((range) => range.from !== start.toISOString()),
          { from: start.toISOString(), to: chunkEnd.toISOString(), code, skippedAt: now.toISOString() }].slice(-MAX_SKIPPED_RANGES);
        await db.update(eloverblikConnections).set({ ...retryState, import_cursor: nextCursor, skipped_ranges: ranges,
          consecutive_failures: 0, next_attempt_at: null, failing_chunk_start: null, chunk_failures: 0 })
          .where(and(eq(eloverblikConnections.id, ID), eq(eloverblikConnections.config_version, version)));
        log('warn', 'eloverblik_chunk_skipped', { code, from: isoDay(start), to: isoDay(chunkEnd) });
        return { status: 'chunk_skipped', code, nextCursor };
      }
      await db.update(eloverblikConnections).set({ ...retryState, consecutive_failures: failures,
        next_attempt_at: attention ? null : nextAttempt, failing_chunk_start: start, chunk_failures: chunkFailures })
        .where(and(eq(eloverblikConnections.id, ID), eq(eloverblikConnections.config_version, version)));
      if (attention) {
        // Transition-only update: one private notification per incident.
        const entered = await db.update(eloverblikConnections).set({ attention_code: code, attention_since: now })
          .where(and(eq(eloverblikConnections.id, ID), eq(eloverblikConnections.config_version, version), isNull(eloverblikConnections.attention_code)))
          .returning({ id: eloverblikConnections.id });
        if (entered.length) {
          log('warn', 'eloverblik_attention_required', { code });
          void notify('energy.meter_attention', { status: code,
            detail: code === 'RECONNECT_REQUIRED' ? 'ElOverblik sync is paused: the refresh token was rejected. Paste a new token to resume.'
              : 'ElOverblik sync is paused: the selected meter is no longer authorized or linked. Check the relation in ElOverblik and reselect the meter.',
            url: portalLink('/admin/energy-data') });
        }
      }
      throw err;
    }
  }, { kind: 'eloverblik-sync' });
  running = work;
  try { return await work; } finally { if (running === work) running = null; }
}

export function parseManualPeriod(from: unknown, to: unknown, now = new Date()): { from: Date; to: Date } {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof from !== 'string' || typeof to !== 'string' || !day.test(from) || !day.test(to)) throw new ElOverblikError('INVALID_PERIOD');
  const start = new Date(`${from}T00:00:00Z`); const end = new Date(`${to}T00:00:00Z`);
  const today = utcDay(now);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || isoDay(start) !== from || isoDay(end) !== to || end <= start
    || end > today || end.getTime() - start.getTime() > MANUAL_PERIOD_MAX_DAYS * 86_400_000
    || start.getTime() < today.getTime() - MANUAL_PERIOD_HISTORY_DAYS * 86_400_000) throw new ElOverblikError('INVALID_PERIOD');
  return { from: start, to: end };
}

export async function manualSyncSelectedMeter(now = new Date(), period: { from: Date; to: Date } | null = null, client = eloverblikClient) {
  const row = await connection();
  if (row?.last_attempt_at && now.getTime() - row.last_attempt_at.getTime() < MANUAL_COOLDOWN_MS) {
    throw new ElOverblikError('RATE_LIMIT', MANUAL_COOLDOWN_MS - (now.getTime() - row.last_attempt_at.getTime()));
  }
  return syncSelectedMeter(now, { client, manual: true, period });
}

async function delayAfterFailure(): Promise<number> {
  const row = await connection().catch(() => undefined);
  const until = Math.max(row?.next_attempt_at?.getTime() ?? 0, row?.retry_after_until?.getTime() ?? 0);
  return until ? Math.max(BACKFILL_STEP_MS, until - Date.now()) : FAILURE_RETRY_MS;
}
function scheduleNext(delayMs: number) {
  if (!schedulerActive) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncSelectedMeter().then((result: any) => {
      if (result?.status === 'deferred') return scheduleNext(Math.min(NORMAL_SYNC_MS, Math.max(BACKFILL_STEP_MS, new Date(result.retryAt).getTime() - Date.now())));
      scheduleNext(result?.nextCursor || result?.status === 'chunk_skipped' ? BACKFILL_STEP_MS : NORMAL_SYNC_MS);
    }).catch(async (err) => {
      if (err instanceof ElOverblikError && err.code === 'CONFIG_CHANGED') return scheduleNext(1_000);
      scheduleNext(Math.min(MAX_BACKOFF_MS, await delayAfterFailure()));
    });
  }, delayMs);
  timer.unref();
}
export function startElOverblikScheduler() {
  if (schedulerActive) return;
  schedulerActive = true;
  scheduleNext(30_000);
}
export function stopElOverblikScheduler() { schedulerActive = false; if (timer) clearTimeout(timer); timer = null; }
