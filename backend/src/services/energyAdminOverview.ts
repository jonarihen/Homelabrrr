import { and, count, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityBills, paypalSubscriptions } from '../db/schema/index.ts';
import { energyDataStatus } from './eloverblik.ts';
import { paypalReconciliationHealth } from './paypalOperations.ts';
import { verifiedContributionSnapshot } from './paypal.ts';
import { householdShareMode } from './energyDashboard.ts';
import { HARDWARE_POLL_INTERVAL_MS } from './hardwareTelemetry.ts';
import { log } from '../utils/logger.ts';

// Administrator overview for the Energy & Budget page: setup and source
// health from stored state only. It never contacts iLO, ElOverblik or PayPal
// and never writes; each part fails independently.
async function part<T>(name: string, read: () => Promise<T>): Promise<T | { status: 'error' }> {
  try { return await read(); }
  catch (err) { log('warn', 'energy_admin_overview_failed', { section: name, error: err }); return { status: 'error' }; }
}

async function hardwareHealth(now: Date) {
  const staleBefore = new Date(now.getTime() - 3 * HARDWARE_POLL_INTERVAL_MS);
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE c.lifecycle_state = 'active')::int AS active,
      count(*) FILTER (WHERE c.lifecycle_state <> 'active')::int AS decommissioned,
      count(*) FILTER (WHERE c.lifecycle_state = 'active' AND c.collection_enabled)::int AS collecting,
      count(*) FILTER (WHERE c.lifecycle_state = 'active' AND c.collection_enabled AND t.last_error_code IS NOT NULL)::int AS degraded,
      count(*) FILTER (WHERE c.lifecycle_state = 'active' AND c.collection_enabled AND (t.last_success_at IS NULL OR t.last_success_at < ${staleBefore}))::int AS stale,
      count(*) FILTER (WHERE c.lifecycle_state = 'active' AND c.control_enabled)::int AS control_enabled,
      count(*) FILTER (WHERE c.lifecycle_state = 'active' AND p.automation_enabled)::int AS automation_enabled,
      count(*) FILTER (WHERE c.lifecycle_state = 'active' AND (p.paused OR p.drift_hold))::int AS held
    FROM hardware_connections c
    LEFT JOIN hardware_telemetry_state t ON t.hardware_id = c.id
    LEFT JOIN hardware_power_policies p ON p.hardware_id = c.id
  `);
  const row = result.rows[0] as Record<string, number>;
  return { status: row.active ? 'configured' : 'unconfigured', active: row.active, decommissioned: row.decommissioned,
    collecting: row.collecting, degraded: row.degraded, stale: row.stale, controlEnabled: row.control_enabled,
    automationEnabled: row.automation_enabled, pausedOrHeld: row.held };
}

async function meterHealth() {
  const status = await energyDataStatus();
  if (!status.configured) return { status: 'unconfigured' as const };
  return { status: status.attention ? 'attention' : status.enabled ? 'enabled' : 'disabled', scope: status.scope,
    lastSuccessAt: status.lastSuccessAt ?? null, lastErrorCode: status.lastErrorCode ?? null, attentionCode: status.attention?.code ?? null,
    backfillInProgress: Boolean(status.backfill?.inProgress), earliestIntervalStart: status.coverage?.earliestIntervalStart ?? null,
    latestIntervalEnd: status.coverage?.latestIntervalEnd ?? null, gapCount: status.gaps?.length ?? 0,
    skippedRangeCount: status.skippedRanges?.length ?? 0, chargesAvailable: Boolean(status.charges?.available) };
}

async function billHealth() {
  const rows = await db.select({ status: electricityBills.status, count: count() }).from(electricityBills)
    .where(ne(electricityBills.status, 'void')).groupBy(electricityBills.status);
  const of = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
  return { due: of('due'), partiallyPaid: of('partially_paid'), paid: of('paid') };
}

async function subscriptionHealth() {
  const rows = await db.select({ status: paypalSubscriptions.status, count: count() }).from(paypalSubscriptions)
    .where(and(eq(paypalSubscriptions.environment, 'live'))).groupBy(paypalSubscriptions.status);
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export async function energyAdminOverview(now = new Date()) {
  const [sharing, hardware, meter, bills, paypalHealth, contributions, subscriptions] = await Promise.all([
    part('sharing', householdShareMode), part('hardware', () => hardwareHealth(now)), part('meter', meterHealth),
    part('bills', billHealth), part('paypal_health', () => paypalReconciliationHealth('live')),
    part('paypal_snapshot', () => verifiedContributionSnapshot('live')), part('subscriptions', subscriptionHealth),
  ]);
  return { householdShare: sharing, hardware, meter, bills, paypal: { health: paypalHealth, contributions, subscriptions } };
}
