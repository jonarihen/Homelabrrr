import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import {
  electricityBills, electricityContracts, electricityCostStatements, hardwareConnections, hardwareEnergyIntervals,
  hardwarePowerPolicies, paypalPostings, pveHosts,
} from '../db/schema/index.ts';
import { weekdayPreset } from './powerPolicy.ts';

// Synthetic fixtures only: no iLO, ElOverblik or PayPal is contacted.
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const dashboard = await import('./energyDashboard.ts');
const { recalculatePaypalAllocations } = await import('./paypalAllocation.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

const MONTH = '2026-08';
const START = new Date('2026-07-31T22:00:00Z');
const END = new Date('2026-08-31T22:00:00Z');
const AFTER = new Date('2026-09-15T12:00:00Z');
let contractId = 0;
let statementId = 0;

function calculation(costOre: string) {
  return { month: MONTH, calculatedLabCostOre: costOre, variableCostOre: costOre, variableCostComplete: true, fixedFeeStatus: 'known',
    allocatedFixedFeeOre: '0', labCoveredSeconds: 2678400, expectedSeconds: 2678400, serverCosts: [{ costOre }], extraLoadCosts: [],
    contractRefs: ['1'], observedThrough: END.toISOString(), labKwh: '400.000000000' };
}

test.before(async () => {
  const [contract] = await fixture.db.insert(electricityContracts).values({ label: 'private contract label', kind: 'fixed_all_in', area: 'DK2',
    valid_from: new Date('2026-01-01T00:00:00Z'), fixed_dkk_per_kwh: '2.500000', provenance: 'private provenance', active: true }).returning();
  contractId = contract.id;
  const [statement] = await fixture.db.insert(electricityCostStatements).values({ contract_id: contractId, period_start: START, period_end: END,
    revision: 1, calculation: calculation('100000'), finalized: true, reason: 'fixture' }).returning();
  statementId = statement.id;
  // Acceptance fixture: 1,000 DKK cost, gross 100 DKK, actual fee 4 DKK.
  await fixture.db.insert(paypalPostings).values([
    { environment: 'live', merchant_id: 'MERCHANT-PRIVATE', provider_transaction_id: 'CAPTURE-PRIVATE', posting_kind: 'gross',
      source_id: 'CAPTURE-PRIVATE', amount_ore: 10000, currency: 'DKK', effective_at: new Date('2026-08-10T10:00:00Z'), verification: 'fixture' },
    { environment: 'live', merchant_id: 'MERCHANT-PRIVATE', provider_transaction_id: 'CAPTURE-PRIVATE', posting_kind: 'fee',
      source_id: 'CAPTURE-PRIVATE', amount_ore: -400, currency: 'DKK', effective_at: new Date('2026-08-10T10:00:00Z'), verification: 'fixture' },
    // Sandbox money never reaches live numbers.
    { environment: 'sandbox', merchant_id: 'SANDBOX', provider_transaction_id: 'SANDBOX-1', posting_kind: 'gross',
      source_id: 'SANDBOX-1', amount_ore: 999900, currency: 'DKK', effective_at: new Date('2026-08-11T10:00:00Z'), verification: 'fixture' },
  ]);
  await recalculatePaypalAllocations(MONTH);
});

test('finalized month: net 96 DKK applied, owner share 904 DKK, progress against the finalized cost', async () => {
  const summary = await dashboard.energySummary(MONTH, AFTER);
  assert.equal(summary.cost.status, 'finalized');
  assert.equal(summary.cost.statementId, statementId);
  assert.equal(summary.funding.status, 'reconciled');
  assert.equal(summary.funding.grossOre, 10000);
  assert.equal(summary.funding.feeDebitsOre, 400);
  assert.equal(summary.funding.knownNetOre, 9600);
  assert.equal(summary.funding.openingCreditOre, 0);
  assert.equal(summary.funding.appliedOre, 9600);
  assert.equal(summary.funding.ownerFundedOre, 90400);
  assert.equal(summary.funding.carryForwardOre, 0);
  assert.deepEqual(summary.funding.progress, { basis: 'finalized_lab_cost', costOre: 100000, appliedOre: 9600, ownerRemainderOre: 90400, status: 'known', percent: 9.6 });
  assert.equal(summary.snapshot.consistent, true);
  assert.doesNotMatch(JSON.stringify(summary), /MERCHANT-PRIVATE|CAPTURE-PRIVATE|SANDBOX|private contract label|private provenance/);
});

test('a revised statement withholds the stale allocation instead of mixing revisions', async () => {
  const [revised] = await fixture.db.insert(electricityCostStatements).values({ contract_id: contractId, period_start: START, period_end: END,
    revision: 2, previous_id: statementId, calculation: calculation('120000'), finalized: true, reason: 'fixture revision' }).returning();
  const stale = await dashboard.energySummary(MONTH, AFTER);
  assert.equal(stale.cost.statementId, revised.id);
  assert.equal(stale.cost.actualOre, '120000');
  assert.equal(stale.funding.status, 'recalculation_pending');
  assert.equal(stale.funding.appliedOre, null);
  assert.equal(stale.funding.progress.percent, null);
  assert.equal(stale.funding.knownNetOre, 9600, 'receipts stay visible while the allocation is recomputed');
  await recalculatePaypalAllocations(MONTH);
  const fresh = await dashboard.energySummary(MONTH, AFTER);
  assert.equal(fresh.funding.status, 'reconciled');
  assert.equal(fresh.funding.ownerFundedOre, 110400);
  assert.equal(fresh.funding.progress.percent, 8);
  const months = await dashboard.energyMonths(3, AFTER);
  const august = months.months.find((item) => item.month === MONTH)!;
  assert.equal(august.costStatus, 'finalized');
  assert.equal(august.costOre, 120000);
  assert.equal(august.statementRevision, 2);
  assert.equal(august.appliedOre, 9600);
  assert.equal(months.months[0].month, '2026-09');
  assert.equal(months.months[0].costStatus, 'open');
});

test('household total stays hidden by default and shows only the chosen aggregate when shared', async () => {
  await fixture.db.insert(electricityBills).values({ contract_id: contractId, period_start: START, period_end: END, amount_ore: 150000,
    paid_ore: 100000, status: 'partially_paid', kind: 'settlement', reference: 'INVOICE-REF-PRIVATE', note: 'private invoice note' });
  const hidden = await dashboard.energySummary(MONTH, AFTER);
  assert.deepEqual(hidden.household, { shared: false });
  assert.doesNotMatch(JSON.stringify(hidden), /150000|INVOICE-REF|private invoice note/);
  await dashboard.setHouseholdShareMode('invoiced');
  const invoiced = await dashboard.energySummary(MONTH, AFTER);
  assert.deepEqual(invoiced.household, { shared: true, basis: 'invoiced', status: 'available', totalOre: 150000, billKind: 'settlement', billStatus: 'partially_paid' });
  await dashboard.setHouseholdShareMode('paid');
  assert.equal((await dashboard.energySummary(MONTH, AFTER)).household.totalOre, 100000);
  assert.doesNotMatch(JSON.stringify(await dashboard.energySummary(MONTH, AFTER)), /INVOICE-REF|private invoice note/);
  await dashboard.setHouseholdShareMode('off');
  assert.deepEqual((await dashboard.energySummary(MONTH, AFTER)).household, { shared: false }, 'disabling hides it again immediately');
  // Unknown stored values are treated as off.
  await fixture.db.execute(sql`UPDATE settings SET value = 'everything' WHERE key = ${dashboard.HOUSEHOLD_SHARE_SETTING}`);
  assert.equal(await dashboard.householdShareMode(), 'off');
});

test('decommissioned machines keep past energy and aliases stay stable', async () => {
  const [pve] = await fixture.db.insert(pveHosts).values({ name: 'pve', host: 'pve.private.internal', token_id: 't', token_secret: 'encrypted' }).returning();
  const [retired] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: pve.id, node_ref: `${pve.id}~old`, target_host: 'ilo-old.private.internal',
    username: 'u', secret: 'encrypted', collection_enabled: false, lifecycle_state: 'decommissioned', created_at: new Date('2026-07-01T00:00:00Z') }).returning();
  const [active] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: pve.id, node_ref: `${pve.id}~new`, target_host: 'ilo-new.private.internal',
    username: 'u', secret: 'encrypted', collection_enabled: true, created_at: new Date('2026-07-01T00:00:00Z') }).returning();
  await fixture.db.insert(hardwareEnergyIntervals).values([
    { hardware_id: retired.id, start_utc: new Date('2026-08-05T10:00:00Z'), end_utc: new Date('2026-08-05T10:15:00Z'), kwh: '0.250000000',
      covered_seconds: 900, expected_seconds: 900, quality: 'measured', method_version: 'fixture' },
    { hardware_id: active.id, start_utc: new Date('2026-08-05T10:00:00Z'), end_utc: new Date('2026-08-05T10:15:00Z'), kwh: '0.500000000',
      covered_seconds: 900, expected_seconds: 900, quality: 'measured', method_version: 'fixture' },
  ]);
  await fixture.db.insert(hardwarePowerPolicies).values({ hardware_id: active.id, schedule: { ...weekdayPreset(), enabled: true },
    price_policy: { enabled: false, basis: 'variable_retail_including_vat', contractRef: '', area: '', version: 1,
      expensive: { enabled: false, threshold: '', hysteresis: '', capMode: 'dynamic' }, cheap: { enabled: false, threshold: '', hysteresis: '' } } });
  const summary = await dashboard.energySummary(MONTH, AFTER);
  assert.equal(summary.telemetry.kwh, 0.75, 'the retired machine still counts for the month it ran');
  assert.equal(summary.telemetry.retiredHostsInPeriod, 1);
  assert.equal(summary.telemetry.configuredHosts, 1);
  const hosts = await dashboard.energyHosts(AFTER);
  assert.deepEqual(hosts.hosts.map((host) => host.alias), ['Server 02']);
  const preview = await dashboard.energyPreview(new Date('2026-10-12T13:59:00Z'));
  assert.equal(preview.hosts[0].alias, 'Server 02');
  assert.equal(preview.hosts[0].status, 'available');
  assert.ok(preview.hosts[0].segments.length >= 2);
  assert.ok(preview.hosts[0].segments.every((segment) => segment.endAt <= preview.through.toISOString()), 'bounded to 24 hours');
  assert.doesNotMatch(JSON.stringify([summary, hosts, preview]), /ilo-old|ilo-new|pve\.private|~old|~new/);
});

test('one failing source degrades only its own section', async () => {
  await fixture.db.execute(sql`ALTER TABLE paypal_month_allocations RENAME TO paypal_month_allocations_hidden`);
  try {
    const summary = await dashboard.energySummary(MONTH, AFTER);
    assert.equal(summary.funding.status, 'error');
    assert.equal(summary.funding.appliedOre, null);
    assert.equal(summary.cost.status, 'finalized');
    assert.equal(summary.telemetry.kwh, 0.75);
    assert.equal(summary.snapshot.consistent, false, 'an unverifiable snapshot is not claimed consistent');
  } finally {
    await fixture.db.execute(sql`ALTER TABLE paypal_month_allocations_hidden RENAME TO paypal_month_allocations`);
  }
});
