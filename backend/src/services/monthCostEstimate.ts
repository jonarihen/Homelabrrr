// Best-guess total for an open month. Everything here is an estimate layered
// on top of the exact, measured cost: it never changes a calculated or
// finalized figure, and it is not used for statements.
//
// Method (hourly_profile_v1), per monitored server:
//   1. Load profile. Recent 15-minute readings are averaged per local hour and
//      weekday/weekend (48 cells), newer readings weighing more (7-day
//      half-life). A cell with few readings is pulled toward that hour's mean
//      over all days, and the hour toward the overall mean, so a short history
//      still gives a sensible weekend and one odd hour cannot dominate.
//   2. Every second of the month without a reading (before monitoring started,
//      outages, and the rest of the month) gets that profile's energy.
//   3. That energy is priced per quarter-hour: published prices where they
//      exist, otherwise the real tariffs plus a spot price estimated the same
//      way from recent day-ahead prices (see estimateMissingSpot).
// The range is an 80% interval from the day-to-day spread of load and of spot,
// with consecutive days treated as partly correlated rather than independent.

export const ESTIMATE_METHOD = 'hourly_profile_v1';
export const ESTIMATE_CONFIDENCE = 0.8;
const SLOT_MS = 900_000;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 28;
const HALF_LIFE_DAYS = 7;
// Pseudo-readings (quarter-hours of fresh data) pulling a cell to its parent mean.
const SHRINKAGE = 1;
const MIN_COVERED_FRACTION = 0.8;
const MIN_HISTORY_SECONDS = 86_400;
const MIN_SPREAD_DAYS = 3;
// Used until three full days exist to measure the real spread.
const FALLBACK_LOAD_CV = 0.25;
const FALLBACK_SPOT_CV = 0.5;
// Correlation assumed between the deviations of two days in the same month.
const DAY_CORRELATION = 0.5;
const Z_80 = 1.2816;

const LOCAL = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const localCache = new Map<number, { cell: number; date: string }>();
// Copenhagen offsets are whole hours, so one lookup serves a whole UTC hour.
function local(ms: number): { cell: number; date: string } {
  const hour = Math.floor(ms / 3_600_000);
  let found = localCache.get(hour);
  if (!found) {
    const parts = Object.fromEntries(LOCAL.formatToParts(new Date(hour * 3_600_000)).map((part) => [part.type, part.value]));
    found = { cell: (parts.weekday === 'Sat' || parts.weekday === 'Sun' ? 24 : 0) + Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
    if (localCache.size > 5000) localCache.clear();
    localCache.set(hour, found);
  }
  return found;
}

interface Sample { atMs: number; value: number; slots: number }
interface Profile { cells: number[]; mean: number; relativeSpread: number | null; absoluteSpread: number | null; days: number }

// Recency-weighted cell means with hierarchical shrinkage (cell -> hour ->
// overall), plus the spread of full-day means.
function buildProfile(samples: Sample[], nowMs: number): Profile {
  const sums = new Array<number>(48).fill(0);
  const weights = new Array<number>(48).fill(0);
  const byDay = new Map<string, { sum: number; slots: number }>();
  let total = 0; let totalWeight = 0;
  for (const sample of samples) {
    const { cell, date } = local(sample.atMs);
    const weight = sample.slots * 0.5 ** (Math.max(0, nowMs - sample.atMs) / DAY_MS / HALF_LIFE_DAYS);
    sums[cell] += sample.value * weight; weights[cell] += weight;
    total += sample.value * weight; totalWeight += weight;
    const day = byDay.get(date) || { sum: 0, slots: 0 };
    day.sum += sample.value * sample.slots; day.slots += sample.slots;
    byDay.set(date, day);
  }
  const mean = totalWeight ? total / totalWeight : 0;
  const hours = Array.from({ length: 24 }, (_, hour) => (sums[hour] + sums[hour + 24] + SHRINKAGE * mean) / (weights[hour] + weights[hour + 24] + SHRINKAGE));
  const cells = sums.map((sum, cell) => (sum + SHRINKAGE * hours[cell % 24]) / (weights[cell] + SHRINKAGE));
  const daily = [...byDay.values()].filter((day) => day.slots >= 96 * MIN_COVERED_FRACTION).map((day) => day.sum / day.slots);
  let absoluteSpread: number | null = null;
  if (daily.length >= MIN_SPREAD_DAYS) {
    const average = daily.reduce((sum, value) => sum + value, 0) / daily.length;
    absoluteSpread = Math.sqrt(daily.reduce((sum, value) => sum + (value - average) ** 2, 0) / (daily.length - 1));
  }
  return { cells, mean, absoluteSpread, relativeSpread: absoluteSpread !== null && mean > 0 ? absoluteSpread / mean : null, days: daily.length };
}

// Standard deviation of the mean of `futureDays` equicorrelated days, plus the
// error of having learned the level from only `historyDays` days.
function levelUncertainty(futureDays: number, historyDays: number): number {
  return Math.sqrt(DAY_CORRELATION + (1 - DAY_CORRELATION) / Math.max(1, futureDays) + 1 / Math.max(1, historyDays));
}

export interface SpotSample { startUtc: Date; endUtc: Date; dkkPerKwh: string }
export interface EstimatedSpot { rows: SpotSample[]; spreadDkkPerKwh: number; historyDays: number }

// Estimated spot for every quarter-hour of [from, to) that has no published
// price. Null when less than a day of price history exists.
export function estimateMissingSpot(published: SpotSample[], now: Date, from: Date, to: Date): EstimatedSpot | null {
  const nowMs = now.getTime();
  const known = published.filter((row) => row.endUtc > row.startUtc).sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  const samples: Sample[] = known.filter((row) => row.startUtc.getTime() >= nowMs - HISTORY_DAYS * DAY_MS)
    .map((row) => ({ atMs: row.startUtc.getTime(), value: Number(row.dkkPerKwh), slots: (row.endUtc.getTime() - row.startUtc.getTime()) / SLOT_MS }));
  if (samples.some((sample) => !Number.isFinite(sample.value))) throw new Error('Invalid spot history');
  if (samples.reduce((sum, sample) => sum + sample.slots, 0) < 96) return null;
  const profile = buildProfile(samples, nowMs);
  const rows: SpotSample[] = [];
  let index = 0;
  for (let at = Math.ceil(from.getTime() / SLOT_MS) * SLOT_MS; at + SLOT_MS <= to.getTime(); at += SLOT_MS) {
    while (index < known.length && known[index].endUtc.getTime() <= at) index++;
    if (index < known.length && known[index].startUtc.getTime() < at + SLOT_MS) continue;
    const dkkPerKwh = profile.cells[local(at).cell].toFixed(6);
    const last = rows[rows.length - 1];
    if (last && last.endUtc.getTime() === at && last.dkkPerKwh === dkkPerKwh) last.endUtc = new Date(at + SLOT_MS);
    else rows.push({ startUtc: new Date(at), endUtc: new Date(at + SLOT_MS), dkkPerKwh });
  }
  return { rows, spreadDkkPerKwh: profile.absoluteSpread ?? Math.abs(profile.mean) * FALLBACK_SPOT_CV, historyDays: profile.days };
}

export interface EstimateBucket { hardwareId: number; startUtc: Date; endUtc: Date; kwh: string; coveredSeconds: number; expectedSeconds: number }
export interface EstimatePrice { startUtc: Date; endUtc: Date; dkkPerKwh: string; estimated: boolean }
export interface EstimateHost { hardwareId: number; from: Date }
export interface ServerEstimateInput {
  now: Date; monthStart: Date; monthEnd: Date;
  // Monitored servers and the instant from which unmeasured time is assumed
  // to have been running (never before the server was known).
  hosts: EstimateHost[];
  buckets: EstimateBucket[];
  // Sorted, non-overlapping prices for the month, published or estimated.
  prices: EstimatePrice[];
  spotSpreadDkkPerKwh: number;
  spotHistoryDays: number;
  // Retail change per 1 DKK/kWh of spot, i.e. 1 + VAT fraction.
  spotToRetail: number;
}
export interface ServerEstimate {
  status: 'estimated' | 'insufficient_data' | 'price_unavailable';
  unmeasuredOre: number; remainingOre: number; sigmaOre: number;
  estimatedKwh: number; estimatedSpotKwh: number; basisDays: number;
}

export function estimateServerMonth(input: ServerEstimateInput): ServerEstimate {
  const nowMs = input.now.getTime(); const startMs = input.monthStart.getTime(); const endMs = input.monthEnd.getTime();
  if (![nowMs, startMs, endMs].every(Number.isFinite) || endMs <= startMs || startMs % SLOT_MS || endMs % SLOT_MS) throw new Error('Invalid estimate period');
  const slotCount = (endMs - startMs) / SLOT_MS;
  const empty: ServerEstimate = { status: 'insufficient_data', unmeasuredOre: 0, remainingOre: 0, sigmaOre: 0, estimatedKwh: 0, estimatedSpotKwh: 0, basisDays: 0 };

  // Price per quarter-hour; NaN where any part of the slot has no price.
  const price = new Float64Array(slotCount).fill(NaN);
  const estimatedPrice = new Uint8Array(slotCount);
  let cursor = 0;
  for (let slot = 0; slot < slotCount; slot++) {
    const from = startMs + slot * SLOT_MS; const to = from + SLOT_MS;
    while (cursor < input.prices.length && input.prices[cursor].endUtc.getTime() <= from) cursor++;
    let covered = 0; let weighted = 0;
    for (let i = cursor; i < input.prices.length && input.prices[i].startUtc.getTime() < to; i++) {
      const overlap = Math.min(to, input.prices[i].endUtc.getTime()) - Math.max(from, input.prices[i].startUtc.getTime());
      if (overlap <= 0) continue;
      covered += overlap; weighted += overlap * Number(input.prices[i].dkkPerKwh);
      if (input.prices[i].estimated) estimatedPrice[slot] = 1;
    }
    if (covered === SLOT_MS && Number.isFinite(weighted)) price[slot] = weighted / SLOT_MS;
  }

  const result: ServerEstimate = { ...empty, status: 'estimated', basisDays: Infinity };
  let loadSigma = 0; let unpriced = false;
  const byHost = new Map<number, EstimateBucket[]>();
  for (const bucket of input.buckets) {
    const from = bucket.startUtc.getTime(); const to = bucket.endUtc.getTime(); const kwh = Number(bucket.kwh);
    if (!(to > from) || !Number.isFinite(kwh) || bucket.coveredSeconds < 0 || bucket.expectedSeconds <= 0) throw new Error('Invalid energy bucket');
    byHost.set(bucket.hardwareId, [...(byHost.get(bucket.hardwareId) || []), bucket]);
    // Measured energy in an hour whose spot was never published to us is
    // priced with the estimate; measured energy with no price fails closed.
    for (let slot = Math.max(0, Math.floor((from - startMs) / SLOT_MS)); slot < slotCount && startMs + slot * SLOT_MS < to; slot++) {
      const overlap = Math.min(to, startMs + (slot + 1) * SLOT_MS) - Math.max(from, startMs + slot * SLOT_MS);
      if (overlap <= 0 || kwh === 0) continue;
      if (Number.isNaN(price[slot])) unpriced = true;
      else if (estimatedPrice[slot]) result.unmeasuredOre += kwh * overlap / (to - from) * price[slot] * 100;
    }
  }
  const spotDays = new Set<string>();
  for (const host of input.hosts) {
    const samples: Sample[] = []; let historySeconds = 0;
    const covered = new Float64Array(slotCount);
    for (const bucket of byHost.get(host.hardwareId) || []) {
      const from = bucket.startUtc.getTime(); const to = bucket.endUtc.getTime();
      if (from >= nowMs - HISTORY_DAYS * DAY_MS && from < nowMs && bucket.coveredSeconds / bucket.expectedSeconds >= MIN_COVERED_FRACTION) {
        samples.push({ atMs: from, value: Number(bucket.kwh) / bucket.coveredSeconds, slots: (to - from) / SLOT_MS });
        historySeconds += bucket.coveredSeconds;
      }
      for (let slot = Math.max(0, Math.floor((from - startMs) / SLOT_MS)); slot < slotCount && startMs + slot * SLOT_MS < to; slot++) {
        const overlap = Math.min(to, startMs + (slot + 1) * SLOT_MS) - Math.max(from, startMs + slot * SLOT_MS);
        if (overlap > 0) covered[slot] += bucket.coveredSeconds * overlap / (to - from);
      }
    }
    if (historySeconds < MIN_HISTORY_SECONDS) return empty;
    const profile = buildProfile(samples, nowMs);
    result.basisDays = Math.min(result.basisDays, historySeconds / 86_400);
    const days = new Set<string>(); let hostOre = 0;
    for (let slot = Math.max(0, Math.floor((host.from.getTime() - startMs) / SLOT_MS)); slot < slotCount; slot++) {
      const from = startMs + slot * SLOT_MS;
      const assumed = (from + SLOT_MS - Math.max(from, host.from.getTime())) / 1000;
      const missing = assumed - Math.min(assumed, covered[slot]);
      if (missing <= 0) continue;
      if (Number.isNaN(price[slot])) { unpriced = true; continue; }
      const place = local(from);
      const kwh = profile.cells[place.cell] * missing;
      const ore = kwh * price[slot] * 100;
      if (from + SLOT_MS <= nowMs) result.unmeasuredOre += ore; else result.remainingOre += ore;
      result.estimatedKwh += kwh; hostOre += ore; days.add(place.date);
      if (estimatedPrice[slot]) { result.estimatedSpotKwh += kwh; spotDays.add(place.date); }
    }
    // Servers share a room and a schedule, so their errors add up, not cancel.
    loadSigma += Math.abs(hostOre) * (profile.relativeSpread ?? FALLBACK_LOAD_CV) * levelUncertainty(days.size, profile.days);
  }
  if (!input.hosts.length) return empty;
  if (unpriced) return { ...empty, status: 'price_unavailable' };
  const spotSigma = result.estimatedSpotKwh * input.spotSpreadDkkPerKwh * input.spotToRetail * 100 * levelUncertainty(spotDays.size, input.spotHistoryDays);
  result.sigmaOre = Math.hypot(loadSigma, spotSigma);
  return result;
}

// Symmetric 80% interval around the total; never below what is already measured.
export function estimateRange(totalOre: bigint, floorOre: bigint, sigmaOre: number): { lowOre: bigint; highOre: bigint } {
  const half = BigInt(Math.round(Z_80 * Math.max(0, sigmaOre)));
  const low = totalOre - half;
  return { lowOre: low < floorOre && floorOre <= totalOre ? floorOre : low, highOre: totalOre + half };
}
