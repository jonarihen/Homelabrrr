import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityContracts } from '../db/schema/index.ts';
import { HARDWARE_POLL_INTERVAL_MS } from './hardwareTelemetry.ts';
import { getApplicablePrice } from './electricityPricing.ts';
import { previewMonthlyElectricity } from './monthlyElectricity.ts';
import { monthlyEnergyFunding } from './energyFunding.ts';
import { getSetting } from '../db/settings.ts';
import { resolvePowerDecision, type ApplicablePowerPrice, type PowerPricePolicy, type WeeklyPowerSchedule, type WritablePowerMode } from './powerPolicy.ts';

export function parseEnergyMonth(value: unknown, now = new Date()): string {
  const month = value === undefined ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(now) : value;
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('INVALID_MONTH');
  return month;
}

export function parseHistoryRange(value: unknown): '24h' | '7d' {
  if (value === undefined || value === '24h') return '24h';
  if (value === '7d') return '7d';
  throw new Error('INVALID_RANGE');
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

type HostRow = { id: number; watts: string | null; mode: string | null; observed_at: Date | null; collection_enabled: boolean; last_error_code: string | null };

export function safeHosts(rows: HostRow[], now: Date) {
  const staleAfterMs = 3 * HARDWARE_POLL_INTERVAL_MS;
  return rows.map((row, index) => {
    const ageSeconds = row.observed_at ? Math.max(0, Math.floor((now.getTime() - new Date(row.observed_at).getTime()) / 1000)) : null;
    const stale = ageSeconds === null || ageSeconds * 1000 > staleAfterMs;
    return { alias: `Server ${String(index + 1).padStart(2, '0')}`, watts: numberOrNull(row.watts), observedAt: row.observed_at,
      ageSeconds, stale, observedMode: row.mode, monitoring: row.collection_enabled ? row.last_error_code ? 'degraded' : 'enabled' : 'disabled' };
  });
}

export async function energyHosts(now = new Date()) {
  const result = await db.execute(sql`
    SELECT c.id, c.collection_enabled, c.control_enabled, c.capabilities,
      s.watts, s.mode, s.observed_at, t.last_error_code,
      p.automation_enabled, p.paused, p.drift_hold, p.schedule, p.price_policy,
      p.manual_mode, p.manual_expires_at, p.latch
    FROM hardware_connections c
    LEFT JOIN LATERAL (
      SELECT watts, mode, observed_at FROM hardware_power_samples
      WHERE hardware_id = c.id ORDER BY observed_at DESC LIMIT 1
    ) s ON true
    LEFT JOIN hardware_telemetry_state t ON t.hardware_id = c.id
    LEFT JOIN hardware_power_policies p ON p.hardware_id = c.id
    WHERE c.lifecycle_state = 'active' ORDER BY c.id LIMIT 100
  `);
  const hosts = safeHosts(result.rows as HostRow[], now);
  const globalPaused = await getSetting('power_automation_paused') === 'true';
  await Promise.all(hosts.map(async (host, index) => {
    const row = result.rows[index] as any;
    if (!row.schedule || !row.price_policy) return;
    try {
      const pricePolicy = row.price_policy as PowerPricePolicy;
      const applicable = pricePolicy.enabled ? await getApplicablePrice(now, pricePolicy) : null;
      const price = applicable?.status === 'valid' && applicable.dkk_per_kwh && applicable.start_utc && applicable.end_utc
        ? applicable as ApplicablePowerPrice : null;
      const manualActive = row.manual_mode && (!row.manual_expires_at || new Date(row.manual_expires_at) > now);
      const capabilities = row.capabilities as { runtimeMode?: string; supportedModes?: string[] } | null;
      const supportedModes = (capabilities?.runtimeMode === 'supported' ? capabilities.supportedModes ?? ['low', 'dynamic', 'high'] : [])
        .filter((mode): mode is WritablePowerMode => ['low', 'dynamic', 'high'].includes(mode));
      const observed = ['low', 'dynamic', 'high', 'os_control'].includes(row.mode) ? row.mode : 'unknown';
      const decision = resolvePowerDecision({ now,
        controlEnabled: Boolean(row.control_enabled && (row.automation_enabled || manualActive)),
        automationPaused: globalPaused || row.paused, driftHold: row.drift_hold,
        actualMode: observed, supportedModes,
        schedule: row.schedule as WeeklyPowerSchedule, pricePolicy,
        price, previousLatch: row.latch,
        manualOverride: manualActive ? { mode: row.manual_mode, expiresAt: row.manual_expires_at ? new Date(row.manual_expires_at) : null } : null,
        manualAction: Boolean(manualActive),
      });
      Object.assign(host, { reason: decision.reason, baseMode: decision.baseMode,
        desiredMode: decision.target, priceStatus: decision.priceStatus,
        priceValidUntil: decision.validUntil });
    } catch { Object.assign(host, { reason: 'policy_unavailable' }); }
  }));
  return { status: result.rows.length ? 'available' : 'unconfigured', hosts };
}

export async function energySummary(month: string, now = new Date()) {
  const measured = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const firstDay = `${month}-01`;
    const bounds = await tx.execute(sql`
      SELECT (${firstDay}::date::timestamp AT TIME ZONE 'Europe/Copenhagen') AS start_at,
        ((${firstDay}::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'Europe/Copenhagen') AS end_at
    `);
    const rawBounds = bounds.rows[0] as { start_at: Date | string; end_at: Date | string };
    const startAt = new Date(rawBounds.start_at);
    const endAt = new Date(rawBounds.end_at);
    const coveredTo = now < startAt ? startAt : now < endAt ? now : endAt;
    const hostRows = await tx.execute(sql`
      SELECT c.id, c.collection_enabled, s.watts, s.mode, s.observed_at, t.last_error_code
      FROM hardware_connections c
      LEFT JOIN LATERAL (
        SELECT watts, mode, observed_at FROM hardware_power_samples
        WHERE hardware_id = c.id ORDER BY observed_at DESC LIMIT 1
      ) s ON true
      LEFT JOIN hardware_telemetry_state t ON t.hardware_id = c.id
      WHERE c.lifecycle_state = 'active' ORDER BY c.id
    `);
    const hosts = safeHosts(hostRows.rows as HostRow[], now);
    const energy = await tx.execute(sql`
      SELECT sum(i.kwh)::text AS kwh, sum(i.covered_seconds)::integer AS covered_seconds,
        sum(i.expected_seconds)::integer AS expected_seconds, max(i.updated_at) AS revised_at
      FROM hardware_energy_intervals i JOIN hardware_connections c ON c.id = i.hardware_id
      WHERE c.lifecycle_state = 'active' AND i.start_utc >= ${startAt} AND i.end_utc <= ${coveredTo}
    `);
    const row = energy.rows[0] as { kwh: string | null; covered_seconds: number | null; expected_seconds: number | null; revised_at: Date | null };
    const fresh = hosts.filter((host) => host.monitoring !== 'disabled' && !host.stale && host.watts !== null);
    const watts = fresh.length ? fresh.reduce((sum, host) => sum + host.watts!, 0) : null;
    const kwh = numberOrNull(row.kwh);
    const possibleSeconds = Math.max(0, (coveredTo.getTime() - startAt.getTime()) / 1000) * hosts.length;
    const coveragePercent = possibleSeconds > 0 && row.covered_seconds !== null ?
      Math.min(100, Math.max(0, row.covered_seconds / possibleSeconds * 100)) : null;
    return {
      month, period: { startAt, endAt, throughAt: coveredTo, timeZone: 'Europe/Copenhagen' },
      telemetry: { status: !hosts.length ? 'unconfigured' : !fresh.length ? 'unavailable' : fresh.length < hosts.length ? 'partial' : 'measured',
        watts, observedAt: fresh.length ? fresh.reduce((latest, host) => !latest || new Date(host.observedAt!) < new Date(latest) ? host.observedAt : latest, null as Date | null) : null,
        monitoredHosts: fresh.length, configuredHosts: hosts.length, kwh, coveragePercent, revisedAt: row.revised_at,
        energyStatus: kwh === null ? 'unavailable' : coveragePercent === 100 ? 'measured' : 'partial' },
    };
  }, { isolationLevel: 'repeatable read' });
  const [contract] = await db.select({ id: electricityContracts.id }).from(electricityContracts)
    .where(and(eq(electricityContracts.active, true), lte(electricityContracts.valid_from, now), gt(electricityContracts.valid_to, now))).limit(1);
  const [openEnded] = contract ? [] : await db.select({ id: electricityContracts.id }).from(electricityContracts)
    .where(and(eq(electricityContracts.active, true), lte(electricityContracts.valid_from, now), sql`${electricityContracts.valid_to} IS NULL`)).limit(1);
  const currentContractRef = contract?.id ?? openEnded?.id;
  let price: { status: string; orePerKwh: number | null; basis: string | null; validUntil: string | null } =
    { status: 'unavailable', orePerKwh: null, basis: null, validUntil: null };
  let cost: { status: string; actualOre: string | null; forecastOre: string | null; components: Array<{ label: string; ore: string }> } =
    { status: 'unavailable', actualOre: null, forecastOre: null, components: [] };
  if (currentContractRef) {
    const applicable = await getApplicablePrice(now, String(currentContractRef));
    if (applicable?.status === 'valid' && applicable.dkk_per_kwh) {
      price = { status: 'valid', orePerKwh: Number(applicable.dkk_per_kwh) * 100,
        basis: applicable.basis, validUntil: applicable.end_utc };
    } else if (applicable) price = { ...price, status: 'incomplete', basis: applicable.basis };
  }
  // A historical month must be priced under the contract that covered that
  // month, even after it is deactivated. Require one contract to span the full
  // period so a mid-month switch cannot produce a deceptively complete total.
  const costContracts = await db.select({ id: electricityContracts.id }).from(electricityContracts)
    .where(and(lte(electricityContracts.valid_from, measured.period.startAt),
      sql`(${electricityContracts.valid_to} IS NULL OR ${electricityContracts.valid_to} >= ${measured.period.endAt})`)).limit(2);
  if (costContracts.length === 1) {
    try {
      const calculation = await previewMonthlyElectricity(month, String(costContracts[0].id), now);
      const serverVariableOre = calculation.serverCosts.reduce((sum, item) => sum + BigInt(item.costOre), 0n).toString();
      const extraVariableOre = calculation.extraLoadCosts.reduce((sum, item) => sum + BigInt(item.costOre), 0n).toString();
      cost = { status: calculation.variableCostComplete && calculation.labCoveredSeconds === calculation.expectedSeconds && calculation.fixedFeeStatus === 'known' ? 'calculated' : 'partial',
        actualOre: calculation.calculatedLabCostOre, forecastOre: calculation.forecast?.forecastTotalOre ?? null,
        components: [{ label: 'Measured server variable cost', ore: serverVariableOre },
          { label: 'Estimated extra load variable cost', ore: extraVariableOre },
          { label: 'Allocated fixed fees', ore: calculation.allocatedFixedFeeOre }] };
    } catch { /* Incomplete or absent inputs stay explicitly unavailable. */ }
  }
  return { ...measured, price, cost, funding: await monthlyEnergyFunding(month) };
}

export async function energyHistory(range: '24h' | '7d', now = new Date()) {
  const start = new Date(now.getTime() - (range === '24h' ? 24 : 168) * 3_600_000);
  const binSeconds = range === '24h' ? 3600 : 7200;
  const result = await db.execute(sql`
    WITH per_host AS (
      SELECT s.hardware_id, to_timestamp(floor(extract(epoch FROM s.observed_at) / ${binSeconds}) * ${binSeconds}) AS at,
        avg(s.watts) AS watts
      FROM hardware_power_samples s JOIN hardware_connections c ON c.id = s.hardware_id
      WHERE c.lifecycle_state = 'active' AND s.observed_at >= ${start} AND s.observed_at <= ${now}
      GROUP BY s.hardware_id, at
    )
    SELECT at, sum(watts)::text AS watts, count(*)::integer AS measured_hosts
    FROM per_host GROUP BY at ORDER BY at LIMIT 100
  `);
  const energy = await db.execute(sql`
    SELECT to_timestamp(floor(extract(epoch FROM i.start_utc) / ${binSeconds}) * ${binSeconds}) AS at,
      sum(i.kwh)::text AS kwh, sum(i.covered_seconds)::integer AS covered_seconds,
      sum(i.expected_seconds)::integer AS expected_seconds, count(DISTINCT i.hardware_id)::integer AS measured_hosts
    FROM hardware_energy_intervals i JOIN hardware_connections c ON c.id = i.hardware_id
    WHERE c.lifecycle_state = 'active' AND i.start_utc >= ${start} AND i.end_utc <= ${now}
    GROUP BY at ORDER BY at LIMIT 100
  `);
  return { range, from: start, through: now, unit: 'W', points: result.rows.map((row: any) =>
    ({ at: row.at, watts: numberOrNull(row.watts), measuredHosts: row.measured_hosts })),
  energy: { unit: 'kWh', method: 'integrated_server_input', binSeconds,
    points: energy.rows.map((row: any) => ({ at: row.at, kwh: numberOrNull(row.kwh),
      coveredSeconds: row.covered_seconds, expectedSeconds: row.expected_seconds, measuredHosts: row.measured_hosts })) } };
}
