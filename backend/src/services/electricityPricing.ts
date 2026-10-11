import { and, eq, lte, gt, desc, lt, inArray } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { electricityContracts, electricityTariffs, electricitySpotPrices, electricityExtraLoads, hardwareEnergyIntervals } from '../db/schema/index.ts';
import { fetchDayAheadPrices, type DayAheadRow } from './dayAheadPrices.ts';
import { resolveApplicablePrice, type ApplicablePrice, type ContractPriceInput, type TariffPriceInput } from './electricityPriceMath.ts';
import { calculateIntervalCost } from './costMath.ts';
import type { PriceBasis } from './powerPolicy.ts';
import { startBackgroundWork } from './backgroundWork.ts';
import { log } from '../utils/logger.ts';
import { extraLoadInterval } from './extraLabLoads.ts';

let spotRefresh: Promise<{ imported: number }> | null = null;
let lastAttempt = 0;
let retryAfter = 0;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncStartTimer: ReturnType<typeof setTimeout> | null = null;

function contractInput(row: typeof electricityContracts.$inferSelect): ContractPriceInput {
  return { ref: String(row.id), kind: row.kind as ContractPriceInput['kind'], area: row.area as ContractPriceInput['area'], validFrom: row.valid_from,
    validTo: row.valid_to, fixedRate: row.fixed_dkk_per_kwh, marginRate: row.spot_margin_dkk_per_kwh, vatRate: row.vat_rate,
    requiredComponents: Array.isArray(row.required_components) ? row.required_components as string[] : null, revision: row.revision };
}

export async function getApplicablePrice(atUtc: Date, selection: string | { contractRef: string; basis: PriceBasis; area: string }, chosenBasis: PriceBasis = 'variable_retail_including_vat'): Promise<ApplicablePrice | null> {
  const contractRef = typeof selection === 'string' ? selection : selection.contractRef;
  const basis = typeof selection === 'string' ? chosenBasis : selection.basis;
  if (!(atUtc instanceof Date) || !Number.isFinite(atUtc.getTime()) || !/^\d+$/.test(contractRef)) return null;
  const [contract] = await db.select().from(electricityContracts).where(and(eq(electricityContracts.id, Number(contractRef)), eq(electricityContracts.active, true))).limit(1);
  if (!contract) return null;
  if (typeof selection !== 'string' && selection.area !== contract.area) return null;
  const tariffRows = await db.select().from(electricityTariffs).where(and(eq(electricityTariffs.contract_id, contract.id), lte(electricityTariffs.valid_from, atUtc), gt(electricityTariffs.valid_to, atUtc)));
  const [spot] = contract.kind === 'spot' ? await db.select().from(electricitySpotPrices)
    .where(and(eq(electricitySpotPrices.area, contract.area), lte(electricitySpotPrices.start_utc, atUtc), gt(electricitySpotPrices.end_utc, atUtc)))
    .orderBy(desc(electricitySpotPrices.start_utc)).limit(1) : [];
  const tariffs: TariffPriceInput[] = tariffRows.map((row) => ({ component: row.component, validFrom: row.valid_from, validTo: row.valid_to, rate: row.dkk_per_kwh, vatIncluded: row.vat_included, provenance: row.provenance, revision: row.revision }));
  return resolveApplicablePrice(atUtc, contractInput(contract), tariffs, spot && {
    area: spot.area, startUtc: spot.start_utc, endUtc: spot.end_utc, rate: spot.dkk_per_kwh,
    revision: spot.source_revision, fetchedAt: spot.fetched_at,
  }, basis);
}

// The scheduler may call this every hour. A six-hour gate prevents repeated
// unchanged fetches; 429 Retry-After is respected. Cached valid intervals remain
// usable through provider outages. Only this function contacts Energi Data Service.
export async function syncPublishedSpotPrices(now = new Date(), fetcher = fetchDayAheadPrices): Promise<{ imported: number }> {
  if (spotRefresh) return spotRefresh;
  if (now.getTime() < Math.max(lastAttempt + 6 * 3600_000, retryAfter)) return { imported: 0 };
  const work = startBackgroundWork(async () => {
    const contracts = await db.select({ area: electricityContracts.area }).from(electricityContracts)
      .where(and(eq(electricityContracts.active, true), eq(electricityContracts.kind, 'spot')));
    const areas = [...new Set(contracts.map((row) => row.area))].filter((area): area is 'DK1' | 'DK2' => area === 'DK1' || area === 'DK2');
    if (!areas.length) return { imported: 0 };
    lastAttempt = now.getTime();
    let imported = 0;
    for (const area of areas) {
      try {
        const rows: DayAheadRow[] = await fetcher(area, now);
        for (const row of rows) {
          await db.insert(electricitySpotPrices).values({ area: row.area, start_utc: row.startUtc, end_utc: row.endUtc, dkk_per_kwh: row.dkkPerKwh, source_revision: row.sourceRevision, fetched_at: now })
            .onConflictDoUpdate({ target: [electricitySpotPrices.area, electricitySpotPrices.start_utc], set: { end_utc: row.endUtc, dkk_per_kwh: row.dkkPerKwh, source_revision: row.sourceRevision, fetched_at: now } });
          imported++;
        }
      } catch (err) {
        if (err && typeof err === 'object' && 'retryAfterMs' in err && typeof err.retryAfterMs === 'number') retryAfter = Math.max(retryAfter, now.getTime() + err.retryAfterMs);
        // Keep the other configured area independent. Current cached prices stay valid.
      }
    }
    return { imported };
  }, { kind: 'electricity-price-sync' }) as unknown as Promise<{ imported: number }>;
  spotRefresh = work;
  try { return await work; } finally { if (spotRefresh === work) spotRefresh = null; }
}

export function startElectricityPriceSync() {
  if (syncTimer) return;
  const run = () => { void syncPublishedSpotPrices().catch((err) => log('warn', 'electricity_spot_sync_failed', { error: err })); };
  syncStartTimer = setTimeout(run, 30_000);
  syncTimer = setInterval(run, 60 * 60_000);
  syncStartTimer.unref(); syncTimer.unref();
}

export function stopElectricityPriceSync() {
  if (syncStartTimer) clearTimeout(syncStartTimer);
  if (syncTimer) clearInterval(syncTimer);
  syncStartTimer = null; syncTimer = null;
}

type ContractRow = typeof electricityContracts.$inferSelect;
type TariffRow = typeof electricityTariffs.$inferSelect;
type SpotRow = typeof electricitySpotPrices.$inferSelect;
export interface PricingInputs { contracts: ContractRow[]; tariffs: TariffRow[]; spots: SpotRow[] }
export interface PriceSegment { startUtc: Date; endUtc: Date; dkkPerKwh: string | null; status: 'valid' | 'incomplete'; reason: string | null; contractRef: string }
const SPOT_ROW_LIMIT = 20_000;

function tariffInput(row: TariffRow): TariffPriceInput {
  return { component: row.component, validFrom: row.valid_from, validTo: row.valid_to, rate: row.dkk_per_kwh, vatIncluded: row.vat_included, provenance: row.provenance, revision: row.revision };
}

// Batched loader: one tariff and one spot query for every contract in a
// period, so previews and forecasts never issue a query per price interval.
export async function loadPricingInputs(database: DbOrTx, contracts: ContractRow[], startUtc: Date, endUtc: Date): Promise<PricingInputs> {
  if (!contracts.length || endUtc <= startUtc) return { contracts, tariffs: [], spots: [] };
  const ids = contracts.map((row) => row.id);
  const tariffs = await database.select().from(electricityTariffs).where(and(inArray(electricityTariffs.contract_id, ids), lt(electricityTariffs.valid_from, endUtc), gt(electricityTariffs.valid_to, startUtc))).orderBy(electricityTariffs.id);
  const areas = [...new Set(contracts.filter((row) => row.kind === 'spot').map((row) => row.area))];
  const spots = areas.length ? await database.select().from(electricitySpotPrices).where(and(inArray(electricitySpotPrices.area, areas), lt(electricitySpotPrices.start_utc, endUtc), gt(electricitySpotPrices.end_utc, startUtc)))
    .orderBy(electricitySpotPrices.area, electricitySpotPrices.start_utc).limit(SPOT_ROW_LIMIT + 1) : [];
  if (spots.length > SPOT_ROW_LIMIT) throw new Error('INVALID_PERIOD_TOO_LONG');
  return { contracts, tariffs, spots };
}

// Pure: splits [startUtc, endUtc) at every contract, tariff and spot boundary
// and resolves each piece with the same resolver getApplicablePrice uses.
// Successive contracts must not overlap; an uncovered gap stays absent, so the
// cost engine reports it as missing price coverage instead of zero.
export function resolvePriceSegments(inputs: PricingInputs, startUtc: Date, endUtc: Date, basis: PriceBasis = 'variable_retail_including_vat'): PriceSegment[] {
  const segments: PriceSegment[] = [];
  const contracts = [...inputs.contracts].sort((a, b) => a.valid_from.getTime() - b.valid_from.getTime() || a.id - b.id);
  let previousEnd = -Infinity;
  for (const contract of contracts) {
    const from = Math.max(startUtc.getTime(), contract.valid_from.getTime());
    const to = Math.min(endUtc.getTime(), contract.valid_to?.getTime() ?? endUtc.getTime());
    if (to <= from) continue;
    if (from < previousEnd) throw new Error('OVERLAPPING_CONTRACT');
    previousEnd = to;
    const tariffs = inputs.tariffs.filter((row) => row.contract_id === contract.id);
    const spots = contract.kind === 'spot' ? inputs.spots.filter((row) => row.area === contract.area) : [];
    const inside = (time: number) => time > from && time < to;
    const boundaries = [...new Set([from, to, ...tariffs.flatMap((row) => [row.valid_from.getTime(), row.valid_to.getTime()]).filter(inside),
      ...spots.flatMap((row) => [row.start_utc.getTime(), row.end_utc.getTime()]).filter(inside)])].sort((a, b) => a - b);
    const input = contractInput(contract);
    const tariffInputs = tariffs.map(tariffInput);
    let spotIndex = 0;
    for (let i = 0; i < boundaries.length - 1; i++) {
      const at = new Date(boundaries[i]);
      while (spotIndex < spots.length && spots[spotIndex].end_utc <= at) spotIndex++;
      const source = spotIndex < spots.length && spots[spotIndex].start_utc <= at ? spots[spotIndex] : null;
      const price = resolveApplicablePrice(at, input, tariffInputs, source ? { area: source.area, startUtc: source.start_utc, endUtc: source.end_utc, rate: source.dkk_per_kwh, revision: source.source_revision, fetchedAt: source.fetched_at } : null, basis);
      segments.push({ startUtc: at, endUtc: new Date(boundaries[i + 1]), dkkPerKwh: price.status === 'valid' ? price.dkk_per_kwh : null,
        status: price.status === 'valid' && price.dkk_per_kwh ? 'valid' : 'incomplete', reason: price.reason, contractRef: String(contract.id) });
    }
  }
  return segments;
}

export async function calculateLabCost(startUtc: Date, endUtc: Date, contractRef: string) {
  if (!/^\d+$/.test(contractRef)) throw new Error('Invalid contract reference');
  const [contract] = await db.select().from(electricityContracts).where(eq(electricityContracts.id, Number(contractRef))).limit(1);
  if (!contract) throw new Error('Contract not found');
  return calculateLabCostForContracts(startUtc, endUtc, [contract], contractRef);
}

// Prices one period under one or several successive (non-overlapping)
// contracts, e.g. a month in which the agreement was superseded.
export async function calculateLabCostForContracts(startUtc: Date, endUtc: Date, contracts: ContractRow[], contractRef = String(contracts[0]?.id ?? '')) {
  if (!(startUtc instanceof Date) || !(endUtc instanceof Date) || endUtc <= startUtc || endUtc.getTime() - startUtc.getTime() > 32 * 86400_000) throw new Error('Invalid cost period');
  if (!contracts.length) throw new Error('Contract not found');
  // Half-open period: an interval starting exactly at endUtc belongs to the
  // next period and must not make this one permanently incomplete.
  const energy = await db.select().from(hardwareEnergyIntervals).where(and(lt(hardwareEnergyIntervals.start_utc, endUtc), gt(hardwareEnergyIntervals.end_utc, startUtc)));
  const extraLoads = await db.select().from(electricityExtraLoads).where(and(lt(electricityExtraLoads.valid_from, endUtc), gt(electricityExtraLoads.valid_to, startUtc))).limit(501);
  if (extraLoads.length > 500) throw new Error('EXTRA_LOAD_LIMIT');
  const byHardware = new Map<number, typeof energy>();
  for (const interval of energy) { const items = byHardware.get(interval.hardware_id) || []; items.push(interval); byHardware.set(interval.hardware_id, items); }
  const inputs = await loadPricingInputs(db, contracts, startUtc, endUtc);
  const prices = resolvePriceSegments(inputs, startUtc, endUtc).filter((segment) => segment.status === 'valid')
    .map((segment) => ({ startUtc: segment.startUtc, endUtc: segment.endUtc, dkkPerKwh: segment.dkkPerKwh!, status: 'valid' as const }));
  const totals = [...byHardware].map(([hardwareId, intervals]) => ({ hardwareId, result: calculateIntervalCost(intervals.map((row) => ({ startUtc: row.start_utc, endUtc: row.end_utc, kwh: row.kwh, coveredSeconds: row.covered_seconds, expectedSeconds: row.expected_seconds })), prices) }));
  const extraTotals = extraLoads.map((load) => ({ load, interval: extraLoadInterval(load, startUtc, endUtc) })).filter((entry) => entry.interval !== null)
    .map(({ load, interval }) => ({ load, result: calculateIntervalCost([interval!], prices) }));
  return { contractRef, contractRefs: contracts.map((row) => String(row.id)), startUtc, endUtc, method: 'uniform_energy_within_15_minute_bucket',
    totals: totals.map(({ hardwareId, result }) => ({ hardwareId, kwhPriced: result.kwhPriced, costOre: result.costOre.toString(), energyCoveredSeconds: result.energyCoveredSeconds, priceCoveredSeconds: result.priceCoveredSeconds, complete: result.complete })),
    extraLoadCosts: extraTotals.map(({ load, result }) => ({ loadId: load.id, sourceKey: load.source_key, label: load.label, quality: 'estimated_constant_watts',
      kwhPriced: result.kwhPriced, costOre: result.costOre.toString(), energyCoveredSeconds: result.energyCoveredSeconds, priceCoveredSeconds: result.priceCoveredSeconds, complete: result.complete })),
    complete: totals.length + extraTotals.length > 0 && [...totals, ...extraTotals].every(({ result }) => result.complete) };
}
