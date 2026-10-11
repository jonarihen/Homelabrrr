import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { eloverblikConnections, eloverblikIntervals, eloverblikChargeSnapshots } from '../db/schema/index.ts';
import { encryptSecret, decryptSecret } from '../utils/secrets.ts';
import { eloverblikClient, ElOverblikClient, ElOverblikError } from './eloverblikClient.ts';
import { normalizeMeterSeries } from './eloverblikNormalize.ts';
import { startBackgroundWork } from './backgroundWork.ts';

const ID = 1;
let running: Promise<unknown> | null = null;
let timer: NodeJS.Timeout | null = null;
let schedulerActive = false;
const NORMAL_SYNC_MS = 6 * 60 * 60_000;
const BACKFILL_STEP_MS = 60_000;
const FAILURE_RETRY_MS = 15 * 60_000;
const MANUAL_COOLDOWN_MS = 5 * 60_000;

async function connection() {
  const [row] = await db.select().from(eloverblikConnections).where(eq(eloverblikConnections.id, ID)).limit(1);
  return row;
}
export async function energyDataStatus() {
  const row = await connection();
  if (!row) return { configured: false, enabled: false, selectedMeter: null, scope: 'household' };
  return { configured: Boolean(row.refresh_token), enabled: row.enabled, selectedMeter: row.selected_meter_id ? `••••${row.selected_meter_id.slice(-4)}` : null,
    scope: row.meter_scope, lastSuccessAt: row.last_success_at, latestIntervalEnd: row.latest_interval_end, lastErrorCode: row.last_error_code };
}
export async function saveRefreshToken(raw: string) {
  if (!raw || raw.length > 8192) throw new ElOverblikError('INVALID_TOKEN');
  // Prove the token can list linked meters before replacing durable configuration.
  await new ElOverblikClient().listMeters(raw);
  const previous = await connection();
  const encrypted = encryptSecret(raw);
  await db.insert(eloverblikConnections).values({ id: ID, refresh_token: encrypted, enabled: false, selected_meter_id: null, meter_scope: 'household', config_version: 1 })
    .onConflictDoUpdate({ target: eloverblikConnections.id, set: { refresh_token: encrypted, enabled: false, selected_meter_id: null,
      meter_scope: 'household', config_version: (previous?.config_version ?? 0) + 1, import_cursor: null, last_error_code: null } });
  eloverblikClient.invalidate();
  if (schedulerActive) scheduleNext(1_000);
}
export async function listAvailableMeters() {
  const row = await connection();
  if (!row?.refresh_token) throw new ElOverblikError('NOT_CONFIGURED');
  return eloverblikClient.listMeters(decryptSecret(row.refresh_token)!);
}
export async function selectMeter(meterId: string, scope: 'household' | 'dedicated_lab') {
  if (!/^\d{18}$/.test(meterId) || !['household', 'dedicated_lab'].includes(scope)) throw new ElOverblikError('INVALID_REQUEST');
  const row = await connection();
  if (!row?.refresh_token) throw new ElOverblikError('NOT_CONFIGURED');
  const meters = await listAvailableMeters();
  if (!meters.some((meter) => meter.id === meterId && meter.hasRelation)) throw new ElOverblikError('METER_UNAUTHORIZED');
  await db.update(eloverblikConnections).set({ selected_meter_id: meterId, meter_scope: scope, enabled: true, import_cursor: null,
    config_version: row.config_version + 1, last_error_code: null }).where(and(eq(eloverblikConnections.id, ID), eq(eloverblikConnections.config_version, row.config_version)));
  eloverblikClient.invalidate();
  if (schedulerActive) scheduleNext(1_000);
}
export async function disconnect() {
  const row = await connection();
  if (!row) return;
  await db.update(eloverblikConnections).set({ refresh_token: null, enabled: false, selected_meter_id: null, import_cursor: null,
    config_version: row.config_version + 1 }).where(eq(eloverblikConnections.id, ID));
  eloverblikClient.invalidate();
}
function isoDay(date: Date) { return date.toISOString().slice(0, 10); }
export async function syncSelectedMeter(now = new Date()) {
  if (running) return running;
  const work = startBackgroundWork(async () => {
    const initial = await connection();
    if (!initial?.enabled || !initial.refresh_token || !initial.selected_meter_id) return { status: 'disabled' };
    const version = initial.config_version;
    const meterId = initial.selected_meter_id;
    const refresh = decryptSecret(initial.refresh_token)!;
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const defaultStart = new Date(end.getTime() - 395 * 86_400_000);
    const overlap = new Date(end.getTime() - 7 * 86_400_000);
    const start = initial.import_cursor ? initial.import_cursor : initial.last_success_at ? overlap : defaultStart;
    const chunkEnd = new Date(Math.min(end.getTime(), start.getTime() + 30 * 86_400_000));
    if (chunkEnd <= start) return { status: 'current' };
    await db.update(eloverblikConnections).set({ last_attempt_at: now }).where(eq(eloverblikConnections.id, ID));
    try {
      const response = await eloverblikClient.timeSeries(refresh, meterId, isoDay(start), isoDay(chunkEnd));
      const intervals = normalizeMeterSeries(response, meterId, now);
      const charges = await eloverblikClient.charges(refresh, meterId).catch(() => null);
      const current = await connection();
      if (current?.config_version !== version || current.selected_meter_id !== meterId || !current.enabled) throw new ElOverblikError('CONFIG_CHANGED');
      await db.transaction(async (tx) => {
        // Serialize against concurrent configuration changes; version checked again inside transaction.
        const [locked] = await tx.select().from(eloverblikConnections).where(eq(eloverblikConnections.id, ID)).for('update');
        if (locked.config_version !== version || !locked.enabled) throw new ElOverblikError('CONFIG_CHANGED');
        for (const value of intervals) await tx.insert(eloverblikIntervals).values(value).onConflictDoUpdate({
          target: [eloverblikIntervals.meter_id, eloverblikIntervals.series_key, eloverblikIntervals.aggregation, eloverblikIntervals.interval_start, eloverblikIntervals.interval_end],
          set: { energy_kwh: value.energy_kwh, quality: value.quality, fetched_at: now },
        });
        if (charges && Array.isArray(charges.result)) {
          const own = charges.result.filter((part: any) => part?.id === meterId);
          if (own.length === 1 && own[0].success === true) {
            const payload = own[0].result ?? own[0];
            const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            await tx.insert(eloverblikChargeSnapshots).values({ meter_id: meterId, content_hash: hash, source_payload: payload, observed_at: now })
              .onConflictDoNothing();
          }
        }
        const latest = intervals.reduce<Date | null>((value, item) => !value || item.interval_end > value ? item.interval_end : value, null);
        await tx.update(eloverblikConnections).set({ last_success_at: now, latest_interval_end: latest || locked.latest_interval_end,
          import_cursor: chunkEnd < end ? chunkEnd : null, last_error_code: null }).where(eq(eloverblikConnections.id, ID));
      });
      return { status: 'ok', count: intervals.length, nextCursor: chunkEnd < end ? chunkEnd : null };
    } catch (err) {
      const code = err instanceof ElOverblikError ? err.code : 'SYNC_FAILED';
      await db.update(eloverblikConnections).set({ last_error_code: code }).where(and(eq(eloverblikConnections.id, ID), eq(eloverblikConnections.config_version, version)));
      throw err;
    }
  }, { kind: 'eloverblik-sync' });
  running = work;
  try { return await work; } finally { if (running === work) running = null; }
}
export async function manualSyncSelectedMeter(now = new Date()) {
  const row = await connection();
  if (row?.last_attempt_at && now.getTime() - row.last_attempt_at.getTime() < MANUAL_COOLDOWN_MS) {
    throw new ElOverblikError('RATE_LIMIT', MANUAL_COOLDOWN_MS - (now.getTime() - row.last_attempt_at.getTime()));
  }
  return syncSelectedMeter(now);
}

function scheduleNext(delayMs: number) {
  if (!schedulerActive) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncSelectedMeter().then((result: any) => {
      scheduleNext(result?.nextCursor ? BACKFILL_STEP_MS : NORMAL_SYNC_MS);
    }).catch((err) => {
      if (err instanceof ElOverblikError && err.code === 'CONFIG_CHANGED') return scheduleNext(1_000);
      const retry = err instanceof ElOverblikError && err.retryAfterMs ? err.retryAfterMs : FAILURE_RETRY_MS;
      scheduleNext(Math.max(BACKFILL_STEP_MS, retry));
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
