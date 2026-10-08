import { and, eq, lte, gt, desc, lt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityContracts, electricityTariffs, electricitySpotPrices, hardwareEnergyIntervals } from '../db/schema/index.ts';
import { fetchDayAheadPrices, type DayAheadRow } from './dayAheadPrices.ts';
import { resolveApplicablePrice, type ApplicablePrice, type ContractPriceInput, type TariffPriceInput } from './electricityPriceMath.ts';
import { calculateIntervalCost } from './costMath.ts';
import type { PriceBasis } from './powerPolicy.ts';
import { startBackgroundWork } from './backgroundWork.ts';

let spotRefresh: Promise<{ imported: number }> | null = null;
let lastAttempt = 0;
let retryAfter = 0;

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
  lastAttempt = now.getTime();
  const work = startBackgroundWork(async () => {
    const contracts = await db.select({ area: electricityContracts.area }).from(electricityContracts)
      .where(and(eq(electricityContracts.active, true), eq(electricityContracts.kind, 'spot')));
    const areas = [...new Set(contracts.map((row) => row.area))].filter((area): area is 'DK1' | 'DK2' => area === 'DK1' || area === 'DK2');
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

export async function calculateLabCost(startUtc: Date, endUtc: Date, contractRef: string) {
  if (!(startUtc instanceof Date) || !(endUtc instanceof Date) || endUtc <= startUtc || endUtc.getTime() - startUtc.getTime() > 32 * 86400_000) throw new Error('Invalid cost period');
  if (!/^\d+$/.test(contractRef)) throw new Error('Invalid contract reference');
  const [contract] = await db.select().from(electricityContracts).where(eq(electricityContracts.id, Number(contractRef))).limit(1);
  if (!contract) throw new Error('Contract not found');
  const energy = await db.select().from(hardwareEnergyIntervals).where(and(lte(hardwareEnergyIntervals.start_utc, endUtc), gt(hardwareEnergyIntervals.end_utc, startUtc)));
  const byHardware = new Map<number, typeof energy>();
  for (const interval of energy) { const items = byHardware.get(interval.hardware_id) || []; items.push(interval); byHardware.set(interval.hardware_id, items); }
  const tariffRows = await db.select().from(electricityTariffs).where(and(eq(electricityTariffs.contract_id, contract.id), lt(electricityTariffs.valid_from, endUtc), gt(electricityTariffs.valid_to, startUtc)));
  const spotRows = contract.kind === 'spot' ? await db.select().from(electricitySpotPrices).where(and(eq(electricitySpotPrices.area, contract.area), lt(electricitySpotPrices.start_utc, endUtc), gt(electricitySpotPrices.end_utc, startUtc))) : [];
  const boundaries = [...new Set([startUtc.getTime(), endUtc.getTime(), ...tariffRows.flatMap((row) => [row.valid_from.getTime(), row.valid_to.getTime()]), ...spotRows.flatMap((row) => [row.start_utc.getTime(), row.end_utc.getTime()]), contract.valid_from.getTime(), contract.valid_to?.getTime() ?? endUtc.getTime()].filter((time) => time >= startUtc.getTime() && time <= endUtc.getTime()))].sort((a, b) => a - b);
  const prices: Array<{ startUtc: Date; endUtc: Date; dkkPerKwh: string; status: 'valid' | 'incomplete' }> = [];
  const tariffInputs: TariffPriceInput[] = tariffRows.map((row) => ({ component: row.component, validFrom: row.valid_from, validTo: row.valid_to, rate: row.dkk_per_kwh, vatIncluded: row.vat_included, provenance: row.provenance, revision: row.revision }));
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = new Date(boundaries[i]); const to = new Date(boundaries[i + 1]);
    const source = spotRows.find((row) => row.start_utc <= from && from < row.end_utc);
    const price = resolveApplicablePrice(from, contractInput(contract), tariffInputs, source ? { area: source.area, startUtc: source.start_utc, endUtc: source.end_utc, rate: source.dkk_per_kwh, revision: source.source_revision, fetchedAt: source.fetched_at } : null, 'variable_retail_including_vat');
    if (price.status === 'valid' && price.dkk_per_kwh) prices.push({ startUtc: from, endUtc: to, dkkPerKwh: price.dkk_per_kwh, status: 'valid' });
  }
  const totals = [...byHardware].map(([hardwareId, intervals]) => ({ hardwareId, result: calculateIntervalCost(intervals.map((row) => ({ startUtc: row.start_utc, endUtc: row.end_utc, kwh: row.kwh, coveredSeconds: row.covered_seconds, expectedSeconds: row.expected_seconds })), prices) }));
  return { contractRef, startUtc, endUtc, method: 'uniform_energy_within_15_minute_bucket', totals: totals.map(({ hardwareId, result }) => ({ hardwareId, kwhPriced: result.kwhPriced, costOre: result.costOre.toString(), energyCoveredSeconds: result.energyCoveredSeconds, priceCoveredSeconds: result.priceCoveredSeconds, complete: result.complete })), complete: totals.length > 0 && totals.every(({ result }) => result.complete) };
}
