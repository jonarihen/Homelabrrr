import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import {
  electricityContracts, electricityCostStatements, hardwareConnections, hardwareEnergyIntervals, hardwarePowerPolicies,
  hardwarePowerSamples, paypalPostings, pveHosts,
} from '../db/schema/index.ts';
import { weekdayPreset } from './powerPolicy.ts';

// Proof that Energy & Budget page reads neither write nor call upstream: the
// application pool connects with default_transaction_read_only=on, so any
// INSERT/UPDATE/DELETE from a read path fails, and fetch throws if touched.
const fixture = await createTestDatabase();
const readOnlyUrl = new URL(fixture.url);
readOnlyUrl.searchParams.set('options', '-c default_transaction_read_only=on');
process.env.DATABASE_URL = readOnlyUrl.toString();
process.env.SECRET_ENCRYPTION_KEY ||= '79'.repeat(32);
const fetchCalls: string[] = [];
globalThis.fetch = (async (url: string | URL | Request) => { fetchCalls.push(String(url)); throw new Error('no upstream calls allowed'); }) as typeof fetch;

const now = new Date('2026-09-20T12:00:00Z');
test.before(async () => {
  const [pve] = await fixture.db.insert(pveHosts).values({ name: 'pve', host: 'pve.test', token_id: 't', token_secret: 'encrypted' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: pve.id, node_ref: `${pve.id}~n`, target_host: 'ilo.test',
    username: 'u', secret: 'encrypted', collection_enabled: true, control_enabled: true,
    capabilities: { runtimeMode: 'supported', supportedModes: ['low', 'dynamic', 'high'] }, created_at: new Date('2026-01-01T00:00:00Z') }).returning();
  const [contract] = await fixture.db.insert(electricityContracts).values({ label: 'c', kind: 'fixed_all_in', area: 'DK2',
    valid_from: new Date('2026-01-01T00:00:00Z'), fixed_dkk_per_kwh: '2.000000', provenance: 'fixture', active: true }).returning();
  await fixture.db.insert(hardwarePowerPolicies).values({ hardware_id: hardware.id, automation_enabled: true, schedule: { ...weekdayPreset(), enabled: true },
    price_policy: { enabled: true, basis: 'variable_retail_including_vat', contractRef: String(contract.id), area: 'DK2', version: 1,
      expensive: { enabled: true, threshold: '3.000000', hysteresis: '0.100000', capMode: 'dynamic' }, cheap: { enabled: false, threshold: '', hysteresis: '' } } });
  await fixture.db.insert(hardwarePowerSamples).values({ hardware_id: hardware.id, observed_at: new Date(now.getTime() - 30_000), watts: '210.5', mode: 'low', node_ref: `${pve.id}~n`, origin: 'fixture' });
  await fixture.db.insert(hardwareEnergyIntervals).values({ hardware_id: hardware.id, start_utc: new Date('2026-09-10T10:00:00Z'),
    end_utc: new Date('2026-09-10T10:15:00Z'), kwh: '0.050000000', covered_seconds: 900, expected_seconds: 900, quality: 'measured', method_version: 'fixture' });
  await fixture.db.insert(electricityCostStatements).values({ contract_id: contract.id, period_start: new Date('2026-07-31T22:00:00Z'),
    period_end: new Date('2026-08-31T22:00:00Z'), revision: 1, finalized: true, reason: 'fixture',
    calculation: { calculatedLabCostOre: '5000', variableCostComplete: true, fixedFeeStatus: 'known', allocatedFixedFeeOre: '0', labCoveredSeconds: 1, expectedSeconds: 1, serverCosts: [], extraLoadCosts: [] } });
  await fixture.db.insert(paypalPostings).values({ environment: 'live', merchant_id: 'M', provider_transaction_id: 'P', posting_kind: 'gross',
    source_id: 'P', amount_ore: 1000, currency: 'DKK', effective_at: new Date('2026-09-02T10:00:00Z'), verification: 'fixture' });
});
test.after(async () => { const { closeDb } = await import('../db/client.ts'); await closeDb(); await fixture.drop(); });

test('every Energy & Budget read succeeds on a read-only connection without upstream calls', async () => {
  const { db } = await import('../db/client.ts');
  await assert.rejects(db.execute(sql`INSERT INTO settings (key, value) VALUES ('probe', 'x')`), 'the pool really is read-only');
  const dashboard = await import('./energyDashboard.ts');
  const { energyAdminOverview } = await import('./energyAdminOverview.ts');
  const summary = await dashboard.energySummary('2026-09', now);
  for (const name of ['telemetry', 'price', 'cost', 'funding'] as const)
    assert.notEqual((summary as any)[name].status, 'error', `${name} section must read without writing`);
  assert.equal(summary.telemetry.watts, 210.5);
  assert.equal(summary.price.status, 'valid');
  const closed = await dashboard.energySummary('2026-08', now);
  assert.equal(closed.cost.status, 'finalized');
  const hosts = await dashboard.energyHosts(now);
  assert.equal((hosts.hosts[0] as { reason?: string }).reason, 'schedule');
  const preview = await dashboard.energyPreview(now);
  assert.equal(preview.hosts[0].status, 'available');
  const history = await dashboard.energyHistory('7d', now);
  assert.ok(history.points.length >= 1);
  const months = await dashboard.energyMonths(3, now);
  assert.ok(months.months.every((month) => month.fundingStatus !== 'error'));
  const overview = await energyAdminOverview(now);
  for (const part of [overview.hardware, overview.meter, overview.bills, overview.paypal.health, overview.paypal.contributions, overview.paypal.subscriptions])
    assert.notEqual((part as { status?: string }).status, 'error');
  assert.deepEqual(fetchCalls, []);
});
