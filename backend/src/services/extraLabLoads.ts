import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityExtraLoads } from '../db/schema/index.ts';
import { calculateIntervalCost, type CostPriceInterval } from './costMath.ts';

export type ExtraLoad = Pick<typeof electricityExtraLoads.$inferSelect, 'id' | 'source_key' | 'label' | 'estimated_watts' | 'valid_from' | 'valid_to' | 'provenance'>;
const SCALE = 1_000_000_000n;

export function estimatedLoadKwh(watts: string, validFrom: Date, validTo: Date, periodStart: Date, periodEnd: Date): string {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(watts)) throw new Error('INVALID_EXTRA_LOAD_WATTS');
  const [whole, fraction = ''] = watts.split('.');
  const milliWatts = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0');
  if (milliWatts <= 0n || milliWatts > 100_000_000n) throw new Error('INVALID_EXTRA_LOAD_WATTS');
  const times = [validFrom, validTo, periodStart, periodEnd].map((date) => date.getTime());
  if (times.some((time) => !Number.isFinite(time)) || times[0] >= times[1] || times[2] >= times[3]) throw new Error('INVALID_EXTRA_LOAD_PERIOD');
  const durationMs = Math.max(0, Math.min(times[1], times[3]) - Math.max(times[0], times[2]));
  // milliWatt * millisecond / 3600 is nanokWh. Round once to 9 decimal places.
  const nanoKwh = (milliWatts * BigInt(durationMs) + 1800n) / 3600n;
  return `${nanoKwh / SCALE}.${String(nanoKwh % SCALE).padStart(9, '0')}`;
}

export function extraLoadInterval(load: ExtraLoad, start: Date, end: Date) {
  const from = new Date(Math.ceil(Math.max(load.valid_from.getTime(), start.getTime()) / 1000) * 1000);
  const to = new Date(Math.floor(Math.min(load.valid_to.getTime(), end.getTime()) / 1000) * 1000);
  if (to <= from) return null;
  const seconds = Math.floor((to.getTime() - from.getTime()) / 1000);
  return { startUtc: from, endUtc: to, kwh: estimatedLoadKwh(load.estimated_watts, load.valid_from, load.valid_to, from, to),
    coveredSeconds: seconds, expectedSeconds: seconds };
}

export function forecastExtraLoadCost(loads: ExtraLoad[], start: Date, end: Date,
  published: Array<{ startUtc: Date; endUtc: Date; dkkPerKwh: string; status: 'valid' }>, scenarioDkkPerKwh: string | null) {
  const known = [...published].sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  const prices: CostPriceInterval[] = [...known];
  if (scenarioDkkPerKwh !== null) {
    let cursor = start.getTime();
    for (const price of known) {
      const from = Math.max(cursor, Math.min(end.getTime(), price.startUtc.getTime()));
      if (from > cursor) prices.push({ startUtc: new Date(cursor), endUtc: new Date(from), dkkPerKwh: scenarioDkkPerKwh, status: 'valid' });
      cursor = Math.max(cursor, Math.min(end.getTime(), price.endUtc.getTime()));
    }
    if (cursor < end.getTime()) prices.push({ startUtc: new Date(cursor), endUtc: end, dkkPerKwh: scenarioDkkPerKwh, status: 'valid' });
  }
  const results = loads.map((load) => extraLoadInterval(load, start, end)).filter((interval) => interval !== null)
    .map((interval) => calculateIntervalCost([interval!], prices));
  return { costOre: results.reduce((sum, result) => sum + result.costOre, 0n),
    complete: results.every((result) => result.complete),
    kwhPriced: results.map((result) => result.kwhPriced),
    loadCount: results.length };
}

export async function listExtraLabLoads() {
  return db.select().from(electricityExtraLoads).orderBy(electricityExtraLoads.valid_from, electricityExtraLoads.id).limit(500);
}

export async function createExtraLabLoad(input: any) {
  const sourceKey = String(input?.sourceKey || '').trim();
  const label = String(input?.label || '').trim();
  const provenance = String(input?.provenance || '').trim();
  const watts = String(input?.estimatedWatts ?? '');
  const from = new Date(input?.validFrom); const to = new Date(input?.validTo);
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(sourceKey) || label.length < 2 || label.length > 120 ||
      !provenance || provenance.length > 1000 || input?.excludesServerEnergy !== true ||
      input?.sourceScope !== 'incremental_excluding_servers' || to <= from ||
      to.getTime() - from.getTime() > 10 * 366 * 86_400_000) throw new Error('INVALID_EXTRA_LOAD');
  estimatedLoadKwh(watts, from, to, from, to);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(237012)`);
    const overlapping = await tx.select({ id: electricityExtraLoads.id }).from(electricityExtraLoads)
      .where(and(eq(electricityExtraLoads.source_key, sourceKey), lt(electricityExtraLoads.valid_from, to), gt(electricityExtraLoads.valid_to, from))).limit(1);
    if (overlapping.length) throw new Error('OVERLAPPING_EXTRA_LOAD');
    const [created] = await tx.insert(electricityExtraLoads).values({ source_key: sourceKey, label,
      estimated_watts: watts, valid_from: from, valid_to: to, excludes_server_energy: true, provenance }).returning();
    return created;
  });
}
