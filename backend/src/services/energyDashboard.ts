import { and, desc, eq, gte, lt, lte, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityBills, electricityContracts, electricityCostStatements, paypalMonthAllocations } from '../db/schema/index.ts';
import { HARDWARE_POLL_INTERVAL_MS } from './hardwareTelemetry.ts';
import { getApplicablePrice } from './electricityPricing.ts';
import { latestFinalizedStatement, previewMonthlyElectricity } from './monthlyElectricity.ts';
import { monthlyEnergyFunding } from './energyFunding.ts';
import { allocateMonth } from './paypalAllocation.ts';
import { startOfLocalDateUtc } from './energyAccounting.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { resolvePowerDecision, type ApplicablePowerPrice, type PowerPricePolicy, type WeeklyPowerSchedule } from './powerPolicy.ts';
import { controllerDecisionInput, observedMode, storedManualOverride, supportedModesFrom, type DecisionState } from './powerDecisionContext.ts';
import { buildPowerPreview } from './powerPreview.ts';
import { pricePolicyBoundaries } from './powerPriceBoundaries.ts';
import { log } from '../utils/logger.ts';

// Member-facing Energy & Budget reads. Every function here is read-only: no
// upstream (iLO, ElOverblik, PayPal, spot provider) call and no DB write. All
// returned objects are explicit allowlists built field by field, never
// filtered admin/vendor rows.

/** Furthest back a member may page; matches the 120-month allocation window. */
export const ENERGY_MONTH_LOOKBACK = 120;
export const HOUSEHOLD_SHARE_SETTING = 'energy_household_total_share';
export type HouseholdShareMode = 'off' | 'invoiced' | 'paid';

export function copenhagenMonth(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(now);
}
function monthIndex(month: string): number {
  const [year, number] = month.split('-').map(Number);
  return year * 12 + number - 1;
}
function monthFromIndex(index: number): string {
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
}
export function monthBounds(month: string) {
  const next = monthFromIndex(monthIndex(month) + 1);
  return { startAt: startOfLocalDateUtc(`${month}-01`), endAt: startOfLocalDateUtc(`${next}-01`) };
}

export function parseEnergyMonth(value: unknown, now = new Date()): string {
  const current = copenhagenMonth(now);
  const month = value === undefined ? current : value;
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('INVALID_MONTH');
  // Bounded: no future months and nothing older than the allocation window.
  const offset = monthIndex(current) - monthIndex(month);
  if (offset < 0 || offset >= ENERGY_MONTH_LOOKBACK) throw new Error('INVALID_MONTH');
  return month;
}

export function parseHistoryRange(value: unknown): '24h' | '7d' {
  if (value === undefined || value === '24h') return '24h';
  if (value === '7d') return '7d';
  throw new Error('INVALID_RANGE');
}

export function parseMonthCount(value: unknown): number {
  if (value === undefined) return 12;
  const count = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error('INVALID_COUNT');
  return count;
}

export function parseHouseholdShareMode(value: unknown): HouseholdShareMode {
  if (value === 'off' || value === 'invoiced' || value === 'paid') return value;
  throw new Error('INVALID_SHARE_MODE');
}

/** Household-total sharing defaults OFF: a missing or unknown value is off. */
export async function householdShareMode(): Promise<HouseholdShareMode> {
  const value = await getSetting(HOUSEHOLD_SHARE_SETTING);
  return value === 'invoiced' || value === 'paid' ? value : 'off';
}
export async function setHouseholdShareMode(mode: HouseholdShareMode): Promise<void> {
  await setSetting(HOUSEHOLD_SHARE_SETTING, parseHouseholdShareMode(mode));
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function oreOrNull(value: unknown): number | null {
  const amount = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(amount) ? amount as number : null;
}

type HostRow = { id: number; alias_rank?: number | string | null; watts: string | null; mode: string | null; observed_at: Date | null;
  collection_enabled: boolean; last_error_code: string | null };

// Aliases are ranked over every connection ever created (decommissioned ones
// are archival and never deleted), so "Server 02" keeps naming the same
// machine after another one is retired.
export function safeHosts(rows: HostRow[], now: Date) {
  const staleAfterMs = 3 * HARDWARE_POLL_INTERVAL_MS;
  return rows.map((row, index) => {
    const ageSeconds = row.observed_at ? Math.max(0, Math.floor((now.getTime() - new Date(row.observed_at).getTime()) / 1000)) : null;
    const stale = ageSeconds === null || ageSeconds * 1000 > staleAfterMs;
    const rank = Number(row.alias_rank ?? index + 1);
    return { alias: `Server ${String(rank).padStart(2, '0')}`, watts: numberOrNull(row.watts), observedAt: row.observed_at,
      ageSeconds, stale, observedMode: row.mode, monitoring: row.collection_enabled ? row.last_error_code ? 'degraded' : 'enabled' : 'disabled' };
  });
}

const HOST_SELECT = sql`
  WITH ranked AS (
    SELECT id, collection_enabled, control_enabled, capabilities, lifecycle_state, created_at,
      row_number() OVER (ORDER BY id) AS alias_rank
    FROM hardware_connections
  )
  SELECT c.id, c.alias_rank, c.collection_enabled, c.control_enabled, c.capabilities, c.lifecycle_state, c.created_at,
    s.watts, s.mode, s.observed_at, t.last_error_code
  FROM ranked c
  LEFT JOIN LATERAL (
    SELECT watts, mode, observed_at FROM hardware_power_samples
    WHERE hardware_id = c.id ORDER BY observed_at DESC LIMIT 1
  ) s ON true
  LEFT JOIN hardware_telemetry_state t ON t.hardware_id = c.id`;

function policyState(row: any, globalPaused: boolean): DecisionState {
  return {
    controlEnabled: Boolean(row.control_enabled), automationEnabled: Boolean(row.automation_enabled),
    paused: globalPaused || Boolean(row.paused), driftHold: Boolean(row.drift_hold),
    supportedModes: supportedModesFrom(row.capabilities),
    schedule: row.schedule as WeeklyPowerSchedule, pricePolicy: row.price_policy as PowerPricePolicy, latch: row.latch,
    manualOverride: storedManualOverride(row.manual_mode, row.manual_expires_at),
  };
}

// One request-scoped price lookup shared by every host, so hosts on the same
// contract do not repeat identical reads.
function priceLookup() {
  const memo = new Map<string, Promise<ApplicablePowerPrice | null>>();
  return (at: Date, policy: PowerPricePolicy): Promise<ApplicablePowerPrice | null> => {
    if (!policy?.enabled) return Promise.resolve(null);
    const key = `${policy.contractRef}|${policy.basis}|${policy.area}|${at.getTime()}`;
    let pending = memo.get(key);
    if (!pending) {
      pending = getApplicablePrice(at, policy).then((value) => value?.status === 'valid' && value.dkk_per_kwh && value.start_utc && value.end_utc
        ? value as ApplicablePowerPrice : null, () => null);
      memo.set(key, pending);
    }
    return pending;
  };
}

async function loadHostPolicies() {
  const result = await db.execute(sql`
    SELECT h.*, p.automation_enabled, p.paused, p.drift_hold, p.schedule, p.price_policy,
      p.manual_mode, p.manual_expires_at, p.latch
    FROM (${HOST_SELECT}) h
    LEFT JOIN hardware_power_policies p ON p.hardware_id = h.id
    WHERE h.lifecycle_state = 'active' ORDER BY h.id LIMIT 100
  `);
  return result.rows as any[];
}

function priceRulesEnabled(policy: PowerPricePolicy | null | undefined): boolean {
  return Boolean(policy?.enabled && (policy.expensive?.enabled || policy.cheap?.enabled));
}

export async function energyHosts(now = new Date()) {
  const rows = await loadHostPolicies();
  const hosts = safeHosts(rows as HostRow[], now);
  const globalPaused = await getSetting('power_automation_paused') === 'true';
  const priceAt = priceLookup();
  await Promise.all(hosts.map(async (host, index) => {
    const row = rows[index];
    if (!row.schedule || !row.price_policy) return;
    try {
      const state = policyState(row, globalPaused);
      const price = await priceAt(now, state.pricePolicy);
      // Same resolver input as the worker (automatic, not a manual command),
      // so the dashboard cannot report a mode the worker would not select.
      const decision = resolvePowerDecision(controllerDecisionInput(state, { now, actualMode: observedMode(row.mode), price }));
      Object.assign(host, { reason: decision.reason, baseMode: decision.baseMode,
        desiredMode: decision.target, priceStatus: decision.priceStatus,
        priceValidUntil: decision.validUntil, priceRulesEnabled: priceRulesEnabled(state.pricePolicy),
        manualUntil: decision.reason === 'manual' ? state.manualOverride?.expiresAt ?? null : null });
    } catch { Object.assign(host, { reason: 'policy_unavailable' }); }
  }));
  return { status: rows.length ? 'available' : 'unconfigured', hosts };
}

export const PREVIEW_HOURS = 24;

// Member-safe combined schedule/price preview for the next 24 hours. Uses the
// same resolver input and price boundaries as the admin preview and worker.
// Periods beyond the published price horizon come back with selectedMode=null
// (unknown) while the weekly baseline is still shown separately.
export async function energyPreview(now = new Date()) {
  const rows = await loadHostPolicies();
  const hosts = safeHosts(rows as HostRow[], now);
  const globalPaused = await getSetting('power_automation_paused') === 'true';
  const priceAt = priceLookup();
  const end = new Date(now.getTime() + PREVIEW_HOURS * 3_600_000);
  const result = await Promise.all(hosts.map(async (host, index) => {
    const row = rows[index];
    if (!row.schedule || !row.price_policy) return { alias: host.alias, status: 'unconfigured', segments: [], nextKnownChangeAt: null, nextKnownMode: null, priceKnownUntil: null, priceRulesEnabled: false };
    try {
      const state = policyState(row, globalPaused);
      const boundaries = await pricePolicyBoundaries(state.pricePolicy, now, end);
      const preview = await buildPowerPreview(controllerDecisionInput(state, { now, actualMode: observedMode(row.mode), price: null }),
        boundaries, (at) => priceAt(at, state.pricePolicy), 1, now);
      const segments = preview.segments.filter((segment) => Date.parse(segment.startUtc) < end.getTime()).map((segment) => ({
        startAt: segment.startUtc, endAt: new Date(Math.min(Date.parse(segment.endUtc), end.getTime())).toISOString(),
        baseMode: segment.baseMode, selectedMode: segment.selectedMode, reason: segment.reason,
        priceStatus: segment.priceStatus, unknown: segment.futurePriceUnknown,
        orePerKwh: segment.priceDkkPerKwh === null ? null : Math.round(Number(segment.priceDkkPerKwh) * 100_000) / 1000,
      }));
      const firstUnknown = segments.find((segment) => segment.unknown);
      const nextKnown = preview.nextKnownTransition && Date.parse(preview.nextKnownTransition) < end.getTime() ? preview.nextKnownTransition : null;
      return { alias: host.alias, status: 'available', segments,
        nextKnownChangeAt: nextKnown,
        nextKnownMode: nextKnown ? segments.find((segment) => segment.startAt === nextKnown)?.selectedMode ?? null : null,
        priceKnownUntil: firstUnknown ? firstUnknown.startAt : null, priceRulesEnabled: priceRulesEnabled(state.pricePolicy) };
    } catch { return { alias: host.alias, status: 'unavailable', segments: [], nextKnownChangeAt: null, nextKnownMode: null, priceKnownUntil: null, priceRulesEnabled: false }; }
  }));
  return { from: now, through: end, timeZone: 'Europe/Copenhagen', hosts: result };
}

// Compact revision tokens for every source the month summary depends on, read
// in one statement. The summary is built between two such reads and rebuilt
// if anything moved, so costs, allocation and carry-forward are never a torn
// mix of incompatible revisions.
async function snapshotRevisions(month: string, startAt: Date, endAt: Date) {
  const result = await db.execute(sql`
    SELECT
      (SELECT coalesce(max(id), 0)::int FROM paypal_postings WHERE environment = 'live' AND currency = 'DKK') AS ledger,
      (SELECT coalesce(max(id), 0)::int FROM paypal_month_allocations WHERE month = ${month}) AS allocation,
      (SELECT coalesce(max(id), 0)::int FROM electricity_cost_statements WHERE period_start = ${startAt} AND finalized) AS statement,
      (SELECT max(updated_at) FROM hardware_energy_intervals WHERE start_utc >= ${startAt} AND start_utc < ${endAt}) AS energy,
      (SELECT md5(coalesce(string_agg(id || ':' || revision || ':' || active || ':' || coalesce(valid_to::text, ''), ',' ORDER BY id), '')) FROM electricity_contracts) AS contracts,
      (SELECT md5(coalesce(string_agg(id || ':' || revision, ',' ORDER BY id), '')) FROM electricity_tariffs WHERE valid_from < ${endAt} AND valid_to > ${startAt}) AS tariffs,
      (SELECT max(fetched_at) FROM electricity_spot_prices WHERE start_utc < ${endAt} AND end_utc > ${startAt}) AS spots,
      (SELECT md5(coalesce(string_agg(id || ':' || status || ':' || coalesce(paid_ore, -1), ',' ORDER BY id), '')) FROM electricity_bills WHERE period_start < ${endAt} AND period_end > ${startAt}) AS bills,
      (SELECT value FROM settings WHERE key = ${HOUSEHOLD_SHARE_SETTING}) AS share
  `);
  return JSON.stringify(result.rows[0], (_key, value) => value instanceof Date ? value.toISOString() : value);
}

async function section<T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try { return await read(); }
  catch (err) {
    // One failing source must not take the whole page down; the section says
    // so explicitly instead of inventing values.
    log('warn', 'energy_summary_section_failed', { section: name, error: err });
    return fallback;
  }
}

async function telemetrySection(startAt: Date, endAt: Date, now: Date) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const coveredTo = now < startAt ? startAt : now < endAt ? now : endAt;
    // Past months keep decommissioned machines that reported energy in them;
    // a machine registered after the month does not count against coverage.
    const hostRows = await tx.execute(sql`
      SELECT * FROM (${HOST_SELECT}) h
      WHERE (h.lifecycle_state = 'active' AND h.created_at < ${coveredTo})
        OR EXISTS (SELECT 1 FROM hardware_energy_intervals i WHERE i.hardware_id = h.id AND i.start_utc >= ${startAt} AND i.start_utc < ${endAt})
      ORDER BY h.id LIMIT 100
    `);
    const all = hostRows.rows as Array<HostRow & { lifecycle_state: string }>;
    const active = all.filter((row) => row.lifecycle_state === 'active');
    const hosts = safeHosts(active, now);
    const energy = await tx.execute(sql`
      SELECT sum(i.kwh)::text AS kwh, sum(i.covered_seconds)::integer AS covered_seconds, max(i.updated_at) AS revised_at
      FROM hardware_energy_intervals i
      WHERE i.start_utc >= ${startAt} AND i.end_utc <= ${coveredTo}
    `);
    const row = energy.rows[0] as { kwh: string | null; covered_seconds: number | null; revised_at: Date | null };
    const fresh = hosts.filter((host) => host.monitoring !== 'disabled' && !host.stale && host.watts !== null);
    const watts = fresh.length ? fresh.reduce((sum, host) => sum + host.watts!, 0) : null;
    const kwh = numberOrNull(row.kwh);
    const possibleSeconds = Math.max(0, (coveredTo.getTime() - startAt.getTime()) / 1000) * all.length;
    const coveragePercent = possibleSeconds > 0 && row.covered_seconds !== null ?
      Math.min(100, Math.max(0, row.covered_seconds / possibleSeconds * 100)) : null;
    return {
      period: { startAt, endAt, throughAt: coveredTo, timeZone: 'Europe/Copenhagen' },
      telemetry: { status: !hosts.length ? 'unconfigured' : !fresh.length ? 'unavailable' : fresh.length < hosts.length ? 'partial' : 'measured',
        watts, observedAt: fresh.length ? fresh.reduce((latest, host) => !latest || new Date(host.observedAt!) < new Date(latest) ? host.observedAt : latest, null as Date | null) : null,
        monitoredHosts: fresh.length, configuredHosts: hosts.length, retiredHostsInPeriod: all.length - active.length,
        kwh, coveragePercent, revisedAt: row.revised_at,
        energyStatus: kwh === null ? 'unavailable' : coveragePercent === 100 ? 'measured' : 'partial',
        source: 'ilo_power_samples_integrated' },
    };
  }, { isolationLevel: 'repeatable read' });
}

type PriceDto = { status: string; orePerKwh: number | null; basis: string | null; validFrom: string | null; validUntil: string | null;
  knownHorizon: string | null; reason: string | null; contractRevision: string | null };
const emptyPrice = (status: string): PriceDto => ({ status, orePerKwh: null, basis: null, validFrom: null, validUntil: null,
  knownHorizon: null, reason: null, contractRevision: null });

async function priceSection(now: Date): Promise<PriceDto> {
  const [contract] = await db.select({ id: electricityContracts.id }).from(electricityContracts)
    .where(and(eq(electricityContracts.active, true), lte(electricityContracts.valid_from, now),
      sql`(${electricityContracts.valid_to} IS NULL OR ${electricityContracts.valid_to} > ${now})`))
    .orderBy(desc(electricityContracts.valid_from)).limit(1);
  if (!contract) return emptyPrice('unavailable');
  const applicable = await getApplicablePrice(now, String(contract.id));
  if (!applicable) return emptyPrice('unavailable');
  const valid = applicable.status === 'valid' && Boolean(applicable.dkk_per_kwh);
  // A missing price is "incomplete", never zero / free electricity.
  return { status: valid ? 'valid' : 'incomplete', orePerKwh: valid ? Number(applicable.dkk_per_kwh) * 100 : null,
    basis: applicable.basis, validFrom: valid ? applicable.start_utc : null, validUntil: valid ? applicable.end_utc : null,
    knownHorizon: applicable.known_horizon, reason: valid ? null : applicable.reason, contractRevision: applicable.contract_revision };
}

type CostDto = { status: string; actualOre: string | null; forecastOre: string | null; forecastStatus: string | null;
  statementId?: number; statementRevision?: number; finalizedAt?: Date; observedThrough: string | null;
  source: 'finalized_statement' | 'live_calculation' | null; fixedFeeStatus: string | null; variableComplete: boolean | null;
  coverageComplete: boolean | null; contractCount: number | null;
  components: Array<{ key: string; label: string; ore: string; status: string }> };
const emptyCost = (status: string): CostDto => ({ status, actualOre: null, forecastOre: null, forecastStatus: null, observedThrough: null,
  source: null, fixedFeeStatus: null, variableComplete: null, coverageComplete: null, contractCount: null, components: [] });

async function costSection(month: string, startAt: Date, endAt: Date, now: Date): Promise<CostDto> {
  // A historical month is priced under the active contract(s) that covered it,
  // including contracts that were end-dated or superseded since. Withdrawn
  // (deactivated) contracts are excluded. A closed month with a finalized
  // statement is read from that immutable statement, never recalculated live.
  const [anchor] = await db.select({ id: electricityContracts.id }).from(electricityContracts)
    .where(and(eq(electricityContracts.active, true), lt(electricityContracts.valid_from, endAt),
      sql`(${electricityContracts.valid_to} IS NULL OR ${electricityContracts.valid_to} > ${startAt})`))
    .orderBy(electricityContracts.valid_from, electricityContracts.id).limit(1);
  if (!anchor || now <= startAt) return emptyCost('unavailable');
  const closed = now >= endAt;
  const statement = closed ? await latestFinalizedStatement(String(anchor.id), month) : null;
  type Calculation = Awaited<ReturnType<typeof previewMonthlyElectricity>> & { partialAcknowledged?: boolean };
  const calculation: Calculation = (statement?.calculation as Calculation | undefined)
    ?? await previewMonthlyElectricity(month, String(anchor.id), now);
  const serverVariableOre = calculation.serverCosts.reduce((sum, item) => sum + BigInt(item.costOre), 0n).toString();
  const extraVariableOre = (calculation.extraLoadCosts || []).reduce((sum, item) => sum + BigInt(item.costOre), 0n).toString();
  const coverageComplete = calculation.labCoveredSeconds === calculation.expectedSeconds;
  const complete = calculation.variableCostComplete && coverageComplete && calculation.fixedFeeStatus === 'known';
  return {
    status: statement ? complete && !calculation.partialAcknowledged ? 'finalized' : 'finalized_partial' : complete ? 'calculated' : 'partial',
    actualOre: calculation.calculatedLabCostOre,
    forecastOre: statement || closed ? null : calculation.forecast?.forecastTotalOre ?? null,
    forecastStatus: statement || closed ? null : calculation.forecast?.status ?? 'unavailable',
    ...(statement ? { statementId: statement.id, statementRevision: statement.revision, finalizedAt: statement.created_at } : {}),
    observedThrough: calculation.observedThrough ?? null,
    source: statement ? 'finalized_statement' : 'live_calculation',
    fixedFeeStatus: calculation.fixedFeeStatus, variableComplete: calculation.variableCostComplete, coverageComplete,
    contractCount: Array.isArray(calculation.contractRefs) ? calculation.contractRefs.length : 1,
    components: [
      { key: 'server_variable', label: 'Measured server energy (purchase and variable charges)', ore: serverVariableOre,
        status: calculation.variableCostComplete && coverageComplete ? 'calculated' : 'partial' },
      { key: 'extra_variable', label: 'Estimated extra loads', ore: extraVariableOre, status: 'estimated' },
      // An open month adds its fixed fees only once the month has closed.
      { key: 'fixed_fees', label: 'Allocated fixed fees', ore: calculation.allocatedFixedFeeOre,
        status: calculation.fixedFeeStatus !== 'known' ? 'incomplete' : closed ? 'calculated' : 'pending_month_end' },
    ] };
}

type Funding = Awaited<ReturnType<typeof monthlyEnergyFunding>>;
type Progress = { status: string; basis: string | null; costOre: number | null; appliedOre: number | null; ownerRemainderOre: number | null; percent: number | null };

function percentOf(applied: number, cost: number): number {
  return Math.round(Math.max(0, Math.min(100, applied / cost * 100)) * 10) / 10;
}

// Funding progress: numerator is eligible verified net credit applied, never
// gross payments or promised monthly amounts. The denominator is either the
// finalized lab cost the allocation used, or (open month) the cost calculated
// so far, labeled as a current estimate. Zero/negative/unknown cost -> no %.
export function fundingProgress(funding: Funding | null, cost: Pick<CostDto, 'status' | 'actualOre'>, closed: boolean): Progress {
  const empty = (status: string, basis: string | null = null): Progress => ({ status, basis, costOre: null, appliedOre: null, ownerRemainderOre: null, percent: null });
  if (!funding) return empty('unavailable');
  if (funding.status === 'reconciled') {
    const costOre = funding.allocationCostOre;
    const applied = funding.appliedOre;
    if (costOre === null || applied === null) return empty('unavailable', 'finalized_lab_cost');
    const base = { basis: 'finalized_lab_cost', costOre, appliedOre: applied, ownerRemainderOre: funding.ownerFundedOre };
    return costOre <= 0 ? { ...base, status: 'no_cost', percent: null } : { ...base, status: 'known', percent: percentOf(applied, costOre) };
  }
  if (!closed && funding.estimateInputs && cost.status === 'calculated') {
    const costOre = oreOrNull(cost.actualOre);
    if (costOre === null) return empty('unavailable', 'current_estimate');
    // Same allocation rule as the month-close allocation (single source).
    const estimate = allocateMonth(funding.estimateInputs.openingBalanceOre, funding.estimateInputs.receivedNetOre, costOre);
    if (estimate.status !== 'known' || estimate.appliedOre === null) return empty('unavailable', 'current_estimate');
    const base = { basis: 'current_estimate', costOre, appliedOre: estimate.appliedOre, ownerRemainderOre: estimate.ownerRemainderOre };
    return costOre <= 0 ? { ...base, status: 'no_cost', percent: null } : { ...base, status: 'estimate', percent: percentOf(estimate.appliedOre, costOre) };
  }
  return empty(cost.status === 'partial' ? 'cost_incomplete' : 'not_finalized');
}

function fundingDto(funding: Funding | null, cost: CostDto, closed: boolean) {
  if (!funding) return { status: 'error', grossOre: null, feeDebitsOre: null, feeCreditsOre: null, refundDebitsOre: null, knownNetOre: null,
    openingCreditOre: null, eligibleNetOre: null, appliedOre: null, ownerFundedOre: null, ownerAdjustmentOre: null, carryForwardOre: null,
    unresolvedOre: null, held: null, reconciledAt: null, revisions: null, progress: fundingProgress(null, cost, closed) };
  // Coherence: a known allocation must have been computed against the very
  // statement revision this summary shows. If the statement was revised
  // since, the allocation is stale and its figures are withheld.
  const stale = funding.status === 'reconciled' && cost.statementId !== undefined && funding.revisions.costStatementId !== cost.statementId;
  const usable: Funding = stale ? { ...funding, status: 'recalculation_pending', openingCreditOre: null, eligibleNetOre: null, appliedOre: null,
    ownerFundedOre: null, ownerAdjustmentOre: null, carryForwardOre: null, allocationCostOre: null, estimateInputs: null } : funding;
  return {
    status: usable.status, grossOre: usable.grossOre, feeDebitsOre: usable.feeDebitsOre, feeCreditsOre: usable.feeCreditsOre,
    refundDebitsOre: usable.refundDebitsOre, knownNetOre: usable.knownNetOre, openingCreditOre: usable.openingCreditOre,
    eligibleNetOre: usable.eligibleNetOre, appliedOre: usable.appliedOre, ownerFundedOre: usable.ownerFundedOre,
    ownerAdjustmentOre: usable.ownerAdjustmentOre, carryForwardOre: usable.carryForwardOre, unresolvedOre: usable.unresolvedOre,
    held: usable.held, reconciledAt: usable.reconciledAt,
    revisions: { ledgerRevision: funding.revisions.ledgerRevision, allocationRevision: funding.revisions.allocationRevision,
      allocationCurrent: funding.revisions.allocationCurrent && !stale },
    progress: fundingProgress(usable, cost, closed),
  };
}

// Only the selected aggregate and its status: never bill references, notes,
// documents, interval readings or meter/account identifiers.
async function householdSection(mode: HouseholdShareMode, startAt: Date, endAt: Date) {
  if (mode === 'off') return { shared: false as const };
  const bills = await db.select({ kind: electricityBills.kind, amount_ore: electricityBills.amount_ore, paid_ore: electricityBills.paid_ore,
    status: electricityBills.status }).from(electricityBills)
    .where(and(ne(electricityBills.status, 'void'), eq(electricityBills.period_start, startAt), eq(electricityBills.period_end, endAt))).limit(50);
  // Prefer settlement invoices; use advance invoices only when no settlement
  // exists for the month. Kinds are never mixed into one total.
  const settlement = bills.filter((bill) => bill.kind === 'settlement');
  const chosen = settlement.length ? settlement : bills.filter((bill) => bill.kind === 'advance');
  if (!chosen.length) return { shared: true as const, basis: mode, status: 'unavailable', totalOre: null, billKind: null, billStatus: null };
  const invoiced = chosen.reduce((sum, bill) => sum + bill.amount_ore, 0);
  const paid = chosen.reduce((sum, bill) => sum + (bill.paid_ore ?? 0), 0);
  const billStatus = chosen.every((bill) => bill.status === 'paid') ? 'paid'
    : chosen.some((bill) => bill.status === 'paid' || bill.status === 'partially_paid') ? 'partially_paid' : 'due';
  return { shared: true as const, basis: mode, status: 'available', totalOre: mode === 'paid' ? paid : invoiced,
    billKind: settlement.length ? 'settlement' : 'advance', billStatus };
}

async function buildSummary(month: string, now: Date, shareMode: HouseholdShareMode) {
  const { startAt, endAt } = monthBounds(month);
  const closed = now >= endAt;
  const measured = await section('telemetry', () => telemetrySection(startAt, endAt, now), {
    period: { startAt, endAt, throughAt: now < endAt ? now : endAt, timeZone: 'Europe/Copenhagen' },
    telemetry: { status: 'error', watts: null, observedAt: null, monitoredHosts: 0, configuredHosts: 0, retiredHostsInPeriod: 0,
      kwh: null, coveragePercent: null, revisedAt: null, energyStatus: 'error', source: 'ilo_power_samples_integrated' },
  });
  const [price, cost, funding, household] = await Promise.all([
    section('price', () => priceSection(now), emptyPrice('error')),
    section('cost', () => costSection(month, startAt, endAt, now), emptyCost('error')),
    section('funding', () => monthlyEnergyFunding(month), null as Funding | null),
    section('household', () => householdSection(shareMode, startAt, endAt), shareMode === 'off' ? { shared: false as const }
      : { shared: true as const, basis: shareMode, status: 'error', totalOre: null, billKind: null, billStatus: null }),
  ]);
  return { month, closed, ...measured, price, cost, funding: fundingDto(funding, cost, closed), household };
}

export async function energySummary(month: string, now = new Date()) {
  const { startAt, endAt } = monthBounds(month);
  let attempts = 0;
  let consistent = false;
  let summary: Awaited<ReturnType<typeof buildSummary>>;
  // A failed revision read must not take the page down either: the summary
  // is then built once and reported as not verified consistent.
  const revisions = () => snapshotRevisions(month, startAt, endAt).catch((err) => {
    log('warn', 'energy_summary_revisions_failed', { error: err }); return null; });
  do {
    attempts += 1;
    const before = await revisions();
    // The sharing choice is read on every request (never cached), so turning
    // it off hides the household total immediately.
    summary = await buildSummary(month, now, await householdShareMode().catch(() => 'off' as const));
    const after = before === null ? null : await revisions();
    consistent = before !== null && before === after;
    if (before === null || after === null) break;
  } while (!consistent && attempts < 3);
  return { ...summary, snapshot: { consistent, attempts } };
}

export async function energyHistory(range: '24h' | '7d', now = new Date()) {
  const start = new Date(now.getTime() - (range === '24h' ? 24 : 168) * 3_600_000);
  const binSeconds = range === '24h' ? 3600 : 7200;
  // History keeps machines decommissioned since: their readings remain part
  // of the lab's record.
  const result = await db.execute(sql`
    WITH per_host AS (
      SELECT s.hardware_id, to_timestamp(floor(extract(epoch FROM s.observed_at) / ${binSeconds}) * ${binSeconds}) AS at,
        avg(s.watts) AS watts
      FROM hardware_power_samples s
      WHERE s.observed_at >= ${start} AND s.observed_at <= ${now}
      GROUP BY s.hardware_id, at
    )
    SELECT at, sum(watts)::text AS watts, count(*)::integer AS measured_hosts
    FROM per_host GROUP BY at ORDER BY at LIMIT 100
  `);
  const energy = await db.execute(sql`
    SELECT to_timestamp(floor(extract(epoch FROM i.start_utc) / ${binSeconds}) * ${binSeconds}) AS at,
      sum(i.kwh)::text AS kwh, sum(i.covered_seconds)::integer AS covered_seconds,
      sum(i.expected_seconds)::integer AS expected_seconds, count(DISTINCT i.hardware_id)::integer AS measured_hosts
    FROM hardware_energy_intervals i
    WHERE i.start_utc >= ${start} AND i.end_utc <= ${now}
    GROUP BY at ORDER BY at LIMIT 100
  `);
  // Verified mode changes only, as chart markers (mode + reason, no actor).
  const modes = await db.execute(sql`
    SELECT completed_at AS at, target_mode AS mode, reason
    FROM hardware_power_operations
    WHERE completed_at >= ${start} AND completed_at <= ${now} AND outcome = 'verified'
    ORDER BY completed_at LIMIT 100
  `);
  return { range, from: start, through: now, unit: 'W', points: result.rows.map((row: any) =>
    ({ at: row.at, watts: numberOrNull(row.watts), measuredHosts: row.measured_hosts })),
  energy: { unit: 'kWh', method: 'integrated_server_input', binSeconds,
    points: energy.rows.map((row: any) => ({ at: row.at, kwh: numberOrNull(row.kwh),
      coveredSeconds: row.covered_seconds, expectedSeconds: row.expected_seconds, measuredHosts: row.measured_hosts })) },
  modeChanges: (modes.rows as any[]).map((row) => ({ at: row.at, mode: row.mode, reason: row.reason })) };
}

// Bounded monthly history from immutable records and aggregates only:
// finalized statements, latest allocations and integrated kWh. Open or
// unfinalized months are labeled as such; nothing is recalculated here.
export async function energyMonths(count: number, now = new Date()) {
  const current = monthIndex(copenhagenMonth(now));
  const months = Array.from({ length: count }, (_, index) => monthFromIndex(current - index));
  const oldest = monthBounds(months[months.length - 1]).startAt;
  const newestEnd = monthBounds(months[0]).endAt;
  const energy = await db.execute(sql`
    SELECT to_char(i.start_utc AT TIME ZONE 'Europe/Copenhagen', 'YYYY-MM') AS month, sum(i.kwh)::text AS kwh
    FROM hardware_energy_intervals i WHERE i.start_utc >= ${oldest} AND i.start_utc < ${newestEnd}
    GROUP BY 1
  `);
  const statements = await db.select({ id: electricityCostStatements.id, period_start: electricityCostStatements.period_start,
    revision: electricityCostStatements.revision, calculation: electricityCostStatements.calculation })
    .from(electricityCostStatements).where(and(eq(electricityCostStatements.finalized, true), gte(electricityCostStatements.period_start, oldest),
      lt(electricityCostStatements.period_start, newestEnd))).orderBy(desc(electricityCostStatements.revision), desc(electricityCostStatements.id)).limit(500);
  const kwhByMonth = new Map((energy.rows as Array<{ month: string; kwh: string }>).map((row) => [row.month, numberOrNull(row.kwh)]));
  const items = await Promise.all(months.map(async (month) => {
    const { startAt, endAt } = monthBounds(month);
    const statement = statements.find((row) => row.period_start.getTime() === startAt.getTime());
    const calculation = statement?.calculation as { calculatedLabCostOre?: string; variableCostComplete?: boolean; fixedFeeStatus?: string; partialAcknowledged?: boolean } | undefined;
    const funding = await monthlyEnergyFunding(month).catch(() => null);
    const stale = funding?.status === 'reconciled' && statement !== undefined && funding.revisions.costStatementId !== statement.id;
    const known = funding?.status === 'reconciled' && !stale;
    return { month, open: now < endAt, kwh: kwhByMonth.get(month) ?? null,
      costStatus: statement ? calculation?.partialAcknowledged ? 'finalized_partial' : 'finalized' : now < endAt ? 'open' : 'not_finalized',
      costOre: statement ? oreOrNull(calculation?.calculatedLabCostOre) : null, statementRevision: statement?.revision ?? null,
      grossOre: funding ? funding.grossOre : null, feeDebitsOre: funding ? funding.feeDebitsOre : null,
      refundDebitsOre: funding ? funding.refundDebitsOre : null,
      knownNetOre: funding ? funding.knownNetOre : null, appliedOre: known ? funding.appliedOre : null,
      ownerFundedOre: known ? funding.ownerFundedOre : null, carryForwardOre: known ? funding.carryForwardOre : null,
      fundingStatus: !funding ? 'error' : stale ? 'recalculation_pending' : funding.status };
  }));
  return { count, timeZone: 'Europe/Copenhagen', months: items };
}

// Admin-only monthly calculation/allocation records for export: every
// statement and allocation revision in a bounded range. No payer data here
// (the PayPal ledger has its own reauth-gated export).
export async function adminBudgetRecords(fromMonth: string, toMonth: string) {
  if (monthIndex(fromMonth) > monthIndex(toMonth) || monthIndex(toMonth) - monthIndex(fromMonth) >= ENERGY_MONTH_LOOKBACK) throw new Error('INVALID_RANGE');
  const from = monthBounds(fromMonth).startAt;
  const to = monthBounds(toMonth).endAt;
  const statements = await db.select({ id: electricityCostStatements.id, contract_id: electricityCostStatements.contract_id,
    period_start: electricityCostStatements.period_start, period_end: electricityCostStatements.period_end, revision: electricityCostStatements.revision,
    previous_id: electricityCostStatements.previous_id, finalized: electricityCostStatements.finalized, created_at: electricityCostStatements.created_at,
    calculation: electricityCostStatements.calculation }).from(electricityCostStatements)
    .where(and(gte(electricityCostStatements.period_start, from), lt(electricityCostStatements.period_start, to)))
    .orderBy(electricityCostStatements.period_start, electricityCostStatements.revision).limit(2001);
  const allocations = await db.select().from(paypalMonthAllocations)
    .where(and(gte(paypalMonthAllocations.month, fromMonth), lte(paypalMonthAllocations.month, toMonth)))
    .orderBy(paypalMonthAllocations.month, paypalMonthAllocations.revision).limit(2001);
  if (statements.length > 2000 || allocations.length > 2000) throw new Error('EXPORT_TOO_LARGE');
  return { statements, allocations };
}
