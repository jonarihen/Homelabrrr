import { and, eq, gte, lte, lt, gt, desc, sql, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, type DbOrTx } from '../db/client.ts';
import { electricityContracts, electricityTariffs, electricitySpotPrices, electricityBills, electricityCostStatements, electricityExtraLoads, eloverblikConnections, eloverblikIntervals, hardwareConnections, hardwareEnergyIntervals, hardwareEnergyDays } from '../db/schema/index.ts';
import { calculateLabCostForContracts, loadPricingInputs, resolvePriceSegments } from './electricityPricing.ts';
import { allocateFixedFee, compareHouseholdEnergy, forecastMonthlyCost, includeMonthlyFixedFee, startOfLocalDateUtc, type DailyEvidence } from './energyAccounting.ts';
import { extraLoadInterval, forecastExtraLoadCost } from './extraLabLoads.ts';

const SCALE = 1_000_000_000n;
function nano(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) throw new Error('Invalid energy');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, '0') || '0');
}
function formatted(value: bigint): string { return `${value / SCALE}.${String(value % SCALE).padStart(9, '0')}`; }
function bounds(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid billing month');
  const [year, number] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
  return { start: startOfLocalDateUtc(`${month}-01`), end: startOfLocalDateUtc(`${next}-01`) };
}
type ContractRow = typeof electricityContracts.$inferSelect;
const MAX_MONTH_CONTRACTS = 20;

// The contracts that price one month. An active anchor brings along every
// other active contract overlapping the month, so a mid-month supersession is
// priced under each agreement for its own validity. Withdrawn (inactive)
// contracts are never chained in; an explicitly chosen inactive contract is
// previewed alone. Statements are stored under the first contract (the anchor).
export async function monthContractChain(database: DbOrTx, contractRef: string, start: Date, end: Date): Promise<ContractRow[]> {
  if (!/^\d+$/.test(contractRef)) throw new Error('Invalid statement input');
  const [anchor] = await database.select().from(electricityContracts).where(eq(electricityContracts.id, Number(contractRef))).limit(1);
  if (!anchor) throw new Error('Contract not found');
  if (!anchor.active) return [anchor];
  const chain = await database.select().from(electricityContracts).where(and(eq(electricityContracts.active, true), lt(electricityContracts.valid_from, end),
    sql`(${electricityContracts.valid_to} IS NULL OR ${electricityContracts.valid_to} > ${start})`)).orderBy(electricityContracts.valid_from, electricityContracts.id).limit(MAX_MONTH_CONTRACTS + 1);
  if (chain.length > MAX_MONTH_CONTRACTS) throw new Error('INVALID_CONTRACT_CHAIN');
  return chain.some((row) => row.id === anchor.id) ? chain : [anchor];
}

function contractSeconds(contract: ContractRow, start: Date, end: Date): number {
  const from = Math.max(start.getTime(), contract.valid_from.getTime());
  const to = Math.min(end.getTime(), contract.valid_to?.getTime() ?? end.getTime());
  return Math.max(0, Math.floor((to - from) / 1000));
}

async function sourceFingerprint(database: DbOrTx, contracts: ContractRow[], start: Date, end: Date): Promise<string> {
  const ids = contracts.map((row) => row.id);
  if (!ids.length) throw new Error('Contract not found');
  const contractRows = await database.select().from(electricityContracts).where(inArray(electricityContracts.id, ids)).orderBy(electricityContracts.id);
  const areas = [...new Set(contractRows.map((row) => row.area))];
  const tariffs = await database.select().from(electricityTariffs).where(and(inArray(electricityTariffs.contract_id, ids), lt(electricityTariffs.valid_from, end), gt(electricityTariffs.valid_to, start))).orderBy(electricityTariffs.id);
  const spots = await database.select().from(electricitySpotPrices).where(and(inArray(electricitySpotPrices.area, areas), lt(electricitySpotPrices.start_utc, end), gt(electricitySpotPrices.end_utc, start))).orderBy(electricitySpotPrices.area, electricitySpotPrices.start_utc);
  const energy = await database.select().from(hardwareEnergyIntervals).where(and(gte(hardwareEnergyIntervals.start_utc, start), lte(hardwareEnergyIntervals.end_utc, end))).orderBy(hardwareEnergyIntervals.hardware_id, hardwareEnergyIntervals.start_utc);
  const extraLoads = await database.select().from(electricityExtraLoads).where(and(lt(electricityExtraLoads.valid_from, end), gt(electricityExtraLoads.valid_to, start))).orderBy(electricityExtraLoads.id).limit(501);
  if (extraLoads.length > 500) throw new Error('EXTRA_LOAD_LIMIT');
  const monitored = await database.select({ id: hardwareConnections.id, collection_enabled: hardwareConnections.collection_enabled, lifecycle_state: hardwareConnections.lifecycle_state }).from(hardwareConnections).where(eq(hardwareConnections.lifecycle_state, 'active')).orderBy(hardwareConnections.id);
  const [meter] = await database.select({ meter: eloverblikConnections.selected_meter_id, scope: eloverblikConnections.meter_scope, version: eloverblikConnections.config_version }).from(eloverblikConnections).where(eq(eloverblikConnections.id, 1)).limit(1);
  const meterIntervals = meter?.meter ? await database.select().from(eloverblikIntervals).where(and(eq(eloverblikIntervals.meter_id, meter.meter), gte(eloverblikIntervals.interval_start, start), lte(eloverblikIntervals.interval_end, end))).orderBy(eloverblikIntervals.id) : [];
  const bills = await database.select().from(electricityBills).where(and(inArray(electricityBills.contract_id, ids), lt(electricityBills.period_start, end), gt(electricityBills.period_end, start))).orderBy(electricityBills.id);
  // Single-contract months keep the historical fingerprint shape.
  const contract = contractRows.length === 1 ? contractRows[0] : contractRows;
  return createHash('sha256').update(JSON.stringify({ contract, tariffs, spots, energy, extraLoads, monitored, meter, meterIntervals, bills })).digest('hex');
}

export async function previewMonthlyElectricity(month: string, contractRef: string, asOf = new Date(), scenarioDkkPerKwh: string | null = null) {
  const { start, end } = bounds(month);
  if (!/^\d+$/.test(contractRef) || !Number.isFinite(asOf.getTime())) throw new Error('Invalid statement input');
  const elapsedEnd = new Date(Math.min(end.getTime(), asOf.getTime()));
  if (elapsedEnd <= start) throw new Error('Month has not started');
  const chain = await monthContractChain(db, contractRef, start, end);
  const contract = chain.find((row) => String(row.id) === contractRef) ?? chain[0];
  const cost = await calculateLabCostForContracts(start, elapsedEnd, chain, contractRef);
  const variableCostOre = [...cost.totals, ...cost.extraLoadCosts].reduce((sum, item) => sum + BigInt(item.costOre), 0n);
  const [meter] = await db.select({ selected_meter_id: eloverblikConnections.selected_meter_id, meter_scope: eloverblikConnections.meter_scope }).from(eloverblikConnections).where(eq(eloverblikConnections.id, 1)).limit(1);
  const rawLab = await db.select().from(hardwareEnergyIntervals).where(and(gte(hardwareEnergyIntervals.start_utc, start), lte(hardwareEnergyIntervals.end_utc, elapsedEnd)));
  const extraLoads = await db.select().from(electricityExtraLoads).where(and(lt(electricityExtraLoads.valid_from, end), gt(electricityExtraLoads.valid_to, start))).limit(501);
  if (extraLoads.length > 500) throw new Error('EXTRA_LOAD_LIMIT');
  const monitored = await db.select({ id: hardwareConnections.id }).from(hardwareConnections).where(and(eq(hardwareConnections.lifecycle_state, 'active'), eq(hardwareConnections.collection_enabled, true)));
  const serverKwh = rawLab.reduce((sum, row) => sum + nano(row.kwh), 0n);
  const extraKwh = extraLoads.reduce((sum, load) => sum + nano(extraLoadInterval(load, start, elapsedEnd)?.kwh || '0'), 0n);
  const labKwh = serverKwh + extraKwh;
  const labCoverageByHardware = new Map<number, number>();
  for (const row of rawLab) labCoverageByHardware.set(row.hardware_id, (labCoverageByHardware.get(row.hardware_id) || 0) + row.covered_seconds);
  const labCoverage = monitored.length && monitored.some((row) => !labCoverageByHardware.has(row.id)) ? 0 : labCoverageByHardware.size ? Math.min(...labCoverageByHardware.values()) : 0;
  const expectedSeconds = Math.floor((elapsedEnd.getTime() - start.getTime()) / 1000);
  const meterRows = meter?.selected_meter_id ? await db.select().from(eloverblikIntervals).where(and(eq(eloverblikIntervals.meter_id, meter.selected_meter_id), eq(eloverblikIntervals.aggregation, 'Actual'), gte(eloverblikIntervals.interval_start, start), lte(eloverblikIntervals.interval_end, elapsedEnd))) : [];
  const series = new Set(meterRows.map((row) => row.series_key));
  const cleanMeter = series.size === 1 && meterRows.every((row) => row.energy_kwh != null);
  const sortedMeter = [...meterRows].sort((a, b) => a.interval_start.getTime() - b.interval_start.getTime());
  const nonOverlapping = sortedMeter.every((row, index) => index === 0 || row.interval_start >= sortedMeter[index - 1].interval_end);
  const householdKwh = cleanMeter && nonOverlapping ? formatted(sortedMeter.reduce((sum, row) => sum + nano(row.energy_kwh!), 0n)) : null;
  const householdCoverage = householdKwh == null ? 0 : sortedMeter.reduce((sum, row) => sum + Math.floor((row.interval_end.getTime() - row.interval_start.getTime()) / 1000), 0);
  const comparison = compareHouseholdEnergy(formatted(labKwh), householdKwh, Math.min(labCoverage, expectedSeconds), Math.min(householdCoverage, expectedSeconds), expectedSeconds, meter?.meter_scope === 'dedicated_lab' ? 'dedicated_lab' : 'household');
  // Each contract's separate monthly fee is allocated once for the part of the
  // month inside that contract's validity (pro rata by time when an agreement
  // starts or ends mid-month), never through the elapsed-day estimate.
  const monthSeconds = Math.floor((end.getTime() - start.getTime()) / 1000);
  const fees = chain.map((row) => {
    const seconds = contractSeconds(row, start, end);
    const monthly = BigInt(row.fixed_monthly_ore || 0);
    const proratedOre = seconds >= monthSeconds ? monthly : (monthly * BigInt(seconds) + BigInt(Math.floor(monthSeconds / 2))) / BigInt(monthSeconds);
    const policy = row.fixed_fee_allocation === 'manual_share' ? { mode: 'manual_share' as const, share: row.fixed_fee_manual_share || '' }
      : row.fixed_fee_allocation === 'energy_proportion' ? { mode: 'energy_proportion' as const } : { mode: 'none' as const };
    return { seconds, ...allocateFixedFee(proratedOre, policy, comparison) };
  }).filter((item) => item.seconds > 0 || chain.length === 1);
  const methods = [...new Set(fees.map((item) => item.method))];
  const fee = { allocatedOre: fees.reduce((sum, item) => sum + item.allocatedOre, 0n),
    status: fees.length && fees.every((item) => item.status === 'known') ? 'known' as const : 'incomplete' as const,
    method: methods.length === 1 ? methods[0] : 'mixed' };
  const bills = await db.select().from(electricityBills).where(and(inArray(electricityBills.contract_id, chain.map((row) => row.id)), lt(electricityBills.period_start, end), gt(electricityBills.period_end, start))).limit(100);
  const dailyRows = await db.select().from(hardwareEnergyDays).where(and(gte(hardwareEnergyDays.local_date, new Date(asOf.getTime() - 35 * 86400_000).toISOString().slice(0, 10)), lt(hardwareEnergyDays.local_date, new Date(asOf.getTime()).toISOString().slice(0, 10))));
  const grouped = new Map<string, { kwh: bigint; coverage: number; expected: number; count: number }>();
  for (const row of dailyRows) {
    const old = grouped.get(row.local_date) || { kwh: 0n, coverage: Infinity, expected: row.expected_seconds, count: 0 };
    old.kwh += nano(row.kwh); old.coverage = Math.min(old.coverage, row.covered_seconds); old.expected = row.expected_seconds; old.count++;
    grouped.set(row.local_date, old);
  }
  const expectedHostCount = monitored.length || Math.max(1, ...[...grouped.values()].map((row) => row.count));
  const evidence: DailyEvidence[] = [...grouped].filter(([, row]) => row.count === expectedHostCount).map(([localDate, row]) => ({ localDate, kwh: formatted(row.kwh), coveredSeconds: row.coverage, expectedSeconds: row.expected }));
  // Published/configured future prices for the rest of the month, resolved in
  // one batched pass instead of a getApplicablePrice round trip per interval.
  const knownFuturePrices: Array<{ startUtc: Date; endUtc: Date; dkkPerKwh: string; status: 'valid' }> = [];
  if (asOf < end) {
    const futureStart = new Date(Math.max(asOf.getTime(), start.getTime()));
    const inputs = await loadPricingInputs(db, chain, futureStart, end);
    for (const segment of resolvePriceSegments(inputs, futureStart, end)) {
      if (segment.status === 'valid' && segment.dkkPerKwh) knownFuturePrices.push({ startUtc: segment.startUtc, endUtc: segment.endUtc, dkkPerKwh: segment.dkkPerKwh, status: 'valid' });
    }
  }
  const baseForecast = asOf < end ? forecastMonthlyCost({ now: asOf, month, actualCostOre: variableCostOre,
    dailyEvidence: evidence, scenarioDkkPerKwh, knownFuturePrices }) : null;
  const extraFuture = asOf < end ? forecastExtraLoadCost(extraLoads, asOf, end, knownFuturePrices, scenarioDkkPerKwh) : null;
  const withExtra = baseForecast && extraFuture ? baseForecast.forecastTotalOre !== null && extraFuture.complete ? {
    ...baseForecast, forecastTotalOre: baseForecast.forecastTotalOre + extraFuture.costOre,
    futureCostOre: baseForecast.futureCostOre! + extraFuture.costOre,
  } : { ...baseForecast, status: baseForecast.status === 'insufficient_data' || extraFuture.complete ? baseForecast.status : 'missing_price_scenario' as const,
    forecastTotalOre: null, futureCostOre: null } : null;
  const forecast = withExtra ? includeMonthlyFixedFee(withExtra, fee.allocatedOre, fee.status) : null;
  const closed = asOf >= end;
  const fingerprint = await sourceFingerprint(db, chain, start, elapsedEnd);
  return { month, contractRef, statementContractRef: String(chain[0].id), contractRefs: chain.map((row) => String(row.id)), periodStart: start.toISOString(), periodEnd: end.toISOString(), observedThrough: elapsedEnd.toISOString(), closed,
    methodVersion: chain.length > 1 ? 'electricity_month_v3_contract_succession' : 'electricity_month_v2_extra_loads', contractRevision: contract.revision,
    contractRevisions: chain.map((row) => ({ contractRef: String(row.id), revision: row.revision, coveredSeconds: contractSeconds(row, start, end) })), sourceFingerprint: fingerprint, variableCostOre: variableCostOre.toString(), serverCosts: cost.totals,
    extraLoadCosts: cost.extraLoadCosts, variableCostComplete: cost.complete, serverKwh: formatted(serverKwh), estimatedExtraKwh: formatted(extraKwh),
    labKwh: formatted(labKwh), labCoveredSeconds: labCoverage, expectedSeconds, household: comparison,
    fixedMonthlyFeeOre: chain.length === 1 ? contract.fixed_monthly_ore : chain.reduce((sum, row) => sum + (row.fixed_monthly_ore || 0), 0), allocatedFixedFeeOre: fee.allocatedOre.toString(), fixedFeeStatus: fee.status, fixedFeeMethod: fee.method,
    calculatedLabCostOre: (variableCostOre + (closed && fee.status === 'known' ? fee.allocatedOre : 0n)).toString(),
    actualBills: bills.map((bill) => ({ id: bill.id, kind: bill.kind, amountOre: bill.amount_ore, status: bill.status, paidOre: bill.paid_ore, paidAt: bill.paid_at })),
    forecast: forecast && { ...forecast, actualCostOre: forecast.actualCostOre.toString(), forecastTotalOre: forecast.forecastTotalOre?.toString() || null,
      futureCostOre: forecast.futureCostOre?.toString() || null, estimatedExtraFutureOre: extraFuture?.complete ? extraFuture.costOre.toString() : null,
      estimatedExtraLoadCount: extraFuture?.loadCount || 0 },
  };
}

export interface FinalizeOptions { acknowledgePartial?: boolean }

// Finalization appends an immutable revision. An incomplete calculation is
// refused unless the administrator explicitly acknowledges the partial
// coverage; the statement then records exactly which coverage was missing and
// never claims to be complete (cost allocation still treats it as unknown).
export async function finalizeMonthlyElectricity(month: string, contractRef: string, reason: string, now = new Date(), options: FinalizeOptions = {}) {
  if (!reason.trim() || reason.length > 1000) throw new Error('Recalculation reason required');
  const { end, start } = bounds(month);
  if (now < end) throw new Error('Cannot finalize an open month');
  const preview = await previewMonthlyElectricity(month, contractRef, now);
  const complete = preview.variableCostComplete && preview.labCoveredSeconds === preview.expectedSeconds && preview.fixedFeeStatus === 'known';
  if (!complete && options.acknowledgePartial !== true) throw new Error('Incomplete calculation cannot be finalized');
  const calculation = complete ? preview : { ...preview, partialAcknowledged: true,
    missingCoverage: { variableCostComplete: preview.variableCostComplete, labCoveredSeconds: preview.labCoveredSeconds,
      expectedSeconds: preview.expectedSeconds, fixedFeeStatus: preview.fixedFeeStatus } };
  const anchorId = Number(preview.statementContractRef);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(237004)`);
    const chain = await monthContractChain(tx, contractRef, start, end);
    if (chain.map((row) => String(row.id)).join(',') !== preview.contractRefs.join(',') || preview.sourceFingerprint !== await sourceFingerprint(tx, chain, start, end)) throw new Error('Calculation inputs changed; preview again');
    const [previous] = await tx.select().from(electricityCostStatements).where(and(eq(electricityCostStatements.contract_id, anchorId), eq(electricityCostStatements.period_start, start), eq(electricityCostStatements.period_end, end))).orderBy(desc(electricityCostStatements.revision)).limit(1);
    const [created] = await tx.insert(electricityCostStatements).values({ contract_id: anchorId, period_start: start, period_end: end, revision: (previous?.revision || 0) + 1, previous_id: previous?.id || null, calculation, finalized: true, reason: reason.trim() }).returning();
    return created;
  });
}

export async function latestFinalizedStatement(contractRef: string, month: string) {
  const { start, end } = bounds(month);
  if (!/^\d+$/.test(contractRef)) throw new Error('Invalid statement input');
  const [row] = await db.select().from(electricityCostStatements).where(and(eq(electricityCostStatements.contract_id, Number(contractRef)), eq(electricityCostStatements.period_start, start),
    eq(electricityCostStatements.period_end, end), eq(electricityCostStatements.finalized, true))).orderBy(desc(electricityCostStatements.revision)).limit(1);
  return row || null;
}
