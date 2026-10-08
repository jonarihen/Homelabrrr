import { and, eq, gte, lte, lt, gt, desc, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, type DbOrTx } from '../db/client.ts';
import { electricityContracts, electricityTariffs, electricitySpotPrices, electricityBills, electricityCostStatements, electricityExtraLoads, eloverblikConnections, eloverblikIntervals, hardwareConnections, hardwareEnergyIntervals, hardwareEnergyDays } from '../db/schema/index.ts';
import { calculateLabCost, getApplicablePrice } from './electricityPricing.ts';
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
async function sourceFingerprint(database: DbOrTx, contractId: number, start: Date, end: Date): Promise<string> {
  const [contract] = await database.select().from(electricityContracts).where(eq(electricityContracts.id, contractId)).limit(1);
  if (!contract) throw new Error('Contract not found');
  const tariffs = await database.select().from(electricityTariffs).where(and(eq(electricityTariffs.contract_id, contractId), lt(electricityTariffs.valid_from, end), gt(electricityTariffs.valid_to, start))).orderBy(electricityTariffs.id);
  const spots = await database.select().from(electricitySpotPrices).where(and(eq(electricitySpotPrices.area, contract.area), lt(electricitySpotPrices.start_utc, end), gt(electricitySpotPrices.end_utc, start))).orderBy(electricitySpotPrices.start_utc);
  const energy = await database.select().from(hardwareEnergyIntervals).where(and(gte(hardwareEnergyIntervals.start_utc, start), lte(hardwareEnergyIntervals.end_utc, end))).orderBy(hardwareEnergyIntervals.hardware_id, hardwareEnergyIntervals.start_utc);
  const extraLoads = await database.select().from(electricityExtraLoads).where(and(lt(electricityExtraLoads.valid_from, end), gt(electricityExtraLoads.valid_to, start))).orderBy(electricityExtraLoads.id).limit(501);
  if (extraLoads.length > 500) throw new Error('EXTRA_LOAD_LIMIT');
  const monitored = await database.select({ id: hardwareConnections.id, collection_enabled: hardwareConnections.collection_enabled, lifecycle_state: hardwareConnections.lifecycle_state }).from(hardwareConnections).where(eq(hardwareConnections.lifecycle_state, 'active')).orderBy(hardwareConnections.id);
  const [meter] = await database.select({ meter: eloverblikConnections.selected_meter_id, scope: eloverblikConnections.meter_scope, version: eloverblikConnections.config_version }).from(eloverblikConnections).where(eq(eloverblikConnections.id, 1)).limit(1);
  const meterIntervals = meter?.meter ? await database.select().from(eloverblikIntervals).where(and(eq(eloverblikIntervals.meter_id, meter.meter), gte(eloverblikIntervals.interval_start, start), lte(eloverblikIntervals.interval_end, end))).orderBy(eloverblikIntervals.id) : [];
  const bills = await database.select().from(electricityBills).where(and(eq(electricityBills.contract_id, contractId), lt(electricityBills.period_start, end), gt(electricityBills.period_end, start))).orderBy(electricityBills.id);
  return createHash('sha256').update(JSON.stringify({ contract, tariffs, spots, energy, extraLoads, monitored, meter, meterIntervals, bills })).digest('hex');
}

export async function previewMonthlyElectricity(month: string, contractRef: string, asOf = new Date(), scenarioDkkPerKwh: string | null = null) {
  const { start, end } = bounds(month);
  if (!/^\d+$/.test(contractRef) || !Number.isFinite(asOf.getTime())) throw new Error('Invalid statement input');
  const elapsedEnd = new Date(Math.min(end.getTime(), asOf.getTime()));
  if (elapsedEnd <= start) throw new Error('Month has not started');
  const [contract] = await db.select().from(electricityContracts).where(eq(electricityContracts.id, Number(contractRef))).limit(1);
  if (!contract) throw new Error('Contract not found');
  const cost = await calculateLabCost(start, elapsedEnd, contractRef);
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
  const fixedPolicy = contract.fixed_fee_allocation === 'manual_share' ? { mode: 'manual_share' as const, share: contract.fixed_fee_manual_share || '' }
    : contract.fixed_fee_allocation === 'energy_proportion' ? { mode: 'energy_proportion' as const } : { mode: 'none' as const };
  const fee = allocateFixedFee(BigInt(contract.fixed_monthly_ore || 0), fixedPolicy, comparison);
  const bills = await db.select().from(electricityBills).where(and(eq(electricityBills.contract_id, contract.id), lt(electricityBills.period_start, end), gt(electricityBills.period_end, start))).limit(100);
  const dailyRows = await db.select().from(hardwareEnergyDays).where(and(gte(hardwareEnergyDays.local_date, new Date(asOf.getTime() - 35 * 86400_000).toISOString().slice(0, 10)), lt(hardwareEnergyDays.local_date, new Date(asOf.getTime()).toISOString().slice(0, 10))));
  const grouped = new Map<string, { kwh: bigint; coverage: number; expected: number; count: number }>();
  for (const row of dailyRows) {
    const old = grouped.get(row.local_date) || { kwh: 0n, coverage: Infinity, expected: row.expected_seconds, count: 0 };
    old.kwh += nano(row.kwh); old.coverage = Math.min(old.coverage, row.covered_seconds); old.expected = row.expected_seconds; old.count++;
    grouped.set(row.local_date, old);
  }
  const expectedHostCount = monitored.length || Math.max(1, ...[...grouped.values()].map((row) => row.count));
  const evidence: DailyEvidence[] = [...grouped].filter(([, row]) => row.count === expectedHostCount).map(([localDate, row]) => ({ localDate, kwh: formatted(row.kwh), coveredSeconds: row.coverage, expectedSeconds: row.expected }));
  const knownFuturePrices: Array<{ startUtc: Date; endUtc: Date; dkkPerKwh: string; status: 'valid' }> = [];
  if (asOf < end) {
    if (contract.kind === 'fixed_all_in') {
      const price = await getApplicablePrice(asOf, contractRef);
      if (price?.status === 'valid' && price.dkk_per_kwh) knownFuturePrices.push({ startUtc: asOf, endUtc: new Date(Math.min(end.getTime(), contract.valid_to?.getTime() ?? end.getTime())), dkkPerKwh: price.dkk_per_kwh, status: 'valid' });
    } else {
      const cached = await db.select().from(electricitySpotPrices).where(and(eq(electricitySpotPrices.area, contract.area), lt(electricitySpotPrices.start_utc, end), gt(electricitySpotPrices.end_utc, asOf))).orderBy(electricitySpotPrices.start_utc).limit(3200);
      for (const row of cached) {
        let cursor = Math.max(asOf.getTime(), row.start_utc.getTime());
        while (cursor < row.end_utc.getTime()) {
          const price = await getApplicablePrice(new Date(cursor), contractRef);
          if (price?.status !== 'valid' || !price.dkk_per_kwh || !price.end_utc) break;
          const next = Math.min(row.end_utc.getTime(), Date.parse(price.end_utc));
          if (next <= cursor) break;
          knownFuturePrices.push({ startUtc: new Date(cursor), endUtc: new Date(next), dkkPerKwh: price.dkk_per_kwh, status: 'valid' });
          cursor = next;
        }
      }
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
  const fingerprint = await sourceFingerprint(db, contract.id, start, elapsedEnd);
  return { month, contractRef, periodStart: start.toISOString(), periodEnd: end.toISOString(), observedThrough: elapsedEnd.toISOString(), closed,
    methodVersion: 'electricity_month_v2_extra_loads', contractRevision: contract.revision, sourceFingerprint: fingerprint, variableCostOre: variableCostOre.toString(), serverCosts: cost.totals,
    extraLoadCosts: cost.extraLoadCosts, variableCostComplete: cost.complete, serverKwh: formatted(serverKwh), estimatedExtraKwh: formatted(extraKwh),
    labKwh: formatted(labKwh), labCoveredSeconds: labCoverage, expectedSeconds, household: comparison,
    fixedMonthlyFeeOre: contract.fixed_monthly_ore, allocatedFixedFeeOre: fee.allocatedOre.toString(), fixedFeeStatus: fee.status, fixedFeeMethod: fee.method,
    calculatedLabCostOre: (variableCostOre + (closed && fee.status === 'known' ? fee.allocatedOre : 0n)).toString(),
    actualBills: bills.map((bill) => ({ id: bill.id, kind: bill.kind, amountOre: bill.amount_ore, status: bill.status, paidOre: bill.paid_ore, paidAt: bill.paid_at })),
    forecast: forecast && { ...forecast, actualCostOre: forecast.actualCostOre.toString(), forecastTotalOre: forecast.forecastTotalOre?.toString() || null,
      futureCostOre: forecast.futureCostOre?.toString() || null, estimatedExtraFutureOre: extraFuture?.complete ? extraFuture.costOre.toString() : null,
      estimatedExtraLoadCount: extraFuture?.loadCount || 0 },
  };
}

export async function finalizeMonthlyElectricity(month: string, contractRef: string, reason: string, now = new Date()) {
  if (!reason.trim() || reason.length > 1000) throw new Error('Recalculation reason required');
  const { end, start } = bounds(month);
  if (now < end) throw new Error('Cannot finalize an open month');
  const calculation = await previewMonthlyElectricity(month, contractRef, now);
  if (!calculation.variableCostComplete || calculation.labCoveredSeconds !== calculation.expectedSeconds || calculation.fixedFeeStatus !== 'known') throw new Error('Incomplete calculation cannot be finalized');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(237004)`);
    if (calculation.sourceFingerprint !== await sourceFingerprint(tx, Number(contractRef), start, end)) throw new Error('Calculation inputs changed; preview again');
    const [previous] = await tx.select().from(electricityCostStatements).where(and(eq(electricityCostStatements.contract_id, Number(contractRef)), eq(electricityCostStatements.period_start, start), eq(electricityCostStatements.period_end, end))).orderBy(desc(electricityCostStatements.revision)).limit(1);
    const [created] = await tx.insert(electricityCostStatements).values({ contract_id: Number(contractRef), period_start: start, period_end: end, revision: (previous?.revision || 0) + 1, previous_id: previous?.id || null, calculation, finalized: true, reason: reason.trim() }).returning();
    return created;
  });
}
