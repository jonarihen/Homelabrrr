import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { electricityContracts, electricitySpotPrices, hardwareConnections, hardwareEnergyIntervals, pveHosts } from '../db/schema/index.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { previewMonthlyElectricity } = await import('./monthlyElectricity.ts');
const { energySummary } = await import('./energyDashboard.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

// June 2026 in Europe/Copenhagen (CEST, no DST change inside the month).
const JUNE_START = new Date('2026-05-31T22:00:00Z');
const QUARTER = 900_000;
const DAY = 86_400_000;
const day = (n: number) => new Date(JUNE_START.getTime() + n * DAY);
const KNOWN_SINCE = new Date('2026-01-01T00:00:00Z');

test('an open month gets a best-guess total from few readings and one day of published spot ahead', async () => {
  const [contract] = await fixture.db.insert(electricityContracts).values({ label: 'spot', kind: 'spot', area: 'DK2', valid_from: KNOWN_SINCE,
    spot_margin_dkk_per_kwh: '0.000000', vat_rate: '0.250000', required_components: [], provenance: 'fixture', active: true }).returning();
  const [pve] = await fixture.db.insert(pveHosts).values({ name: 'estimate', host: 'pve.estimate.test', token_id: 't', token_secret: 'encrypted', created_at: KNOWN_SINCE }).returning();
  const [host] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: pve.id, node_ref: `${pve.id}~node`, target_host: 'ilo.estimate.test',
    username: 'u', secret: 'encrypted', collection_enabled: true, created_at: day(1) }).returning();
  // Monitoring started on the second local day; spot is cached from then until one day ahead.
  const now = day(4);
  const energy = Array.from({ length: 3 * 96 }, (_, index) => ({ hardware_id: host.id, start_utc: new Date(day(1).getTime() + index * QUARTER),
    end_utc: new Date(day(1).getTime() + (index + 1) * QUARTER), kwh: '0.100000000', covered_seconds: 900, expected_seconds: 900, quality: 'measured', method_version: 'fixture' }));
  await fixture.db.insert(hardwareEnergyIntervals).values(energy);
  const spot = Array.from({ length: 4 * 96 }, (_, index) => ({ area: 'DK2', start_utc: new Date(day(1).getTime() + index * QUARTER),
    end_utc: new Date(day(1).getTime() + (index + 1) * QUARTER), dkk_per_kwh: '1.000000', source_revision: 'fixture', fetched_at: now }));
  await fixture.db.insert(electricitySpotPrices).values(spot);

  const preview = await previewMonthlyElectricity('2026-06', String(contract.id), now);
  // 3 measured days x 9.6 kWh x 1.25 DKK.
  assert.equal(preview.variableCostOre, '3600');
  assert.equal(preview.forecast?.status, 'insufficient_data', 'the strict scenario forecast is unchanged');
  assert.deepEqual(preview.estimate, { status: 'estimated', method: 'hourly_profile_v1', confidence: 0.8, measuredOre: '3600', fixedFeeOre: '0',
    // The unmonitored first day, then 26 remaining days, all at 9.6 kWh x 1.25 DKK.
    totalOre: '36000', lowOre: '36000', highOre: '36000', unmeasuredOre: '1200', remainingOre: '31200',
    estimatedKwh: 259.2, basisDays: 3, estimatedPriceShare: 0.963 });

  const summary = await energySummary('2026-06', now);
  assert.equal(summary.cost.estimate?.totalOre, '36000');
  assert.equal(summary.cost.actualOre, '3600', 'the calculated cost is not replaced by the guess');

  const closed = await previewMonthlyElectricity('2026-06', String(contract.id), day(31));
  assert.equal('estimate' in closed, false, 'a closed month carries no estimate into its statement');
  assert.equal((await energySummary('2026-06', day(31))).cost.estimate, null);
});

test('a server first seen mid-month is not assumed to have run before that', async () => {
  const [contract] = await fixture.db.select().from(electricityContracts).limit(1);
  await fixture.db.update(pveHosts).set({ created_at: day(1) });
  const estimate = (await previewMonthlyElectricity('2026-06', String(contract.id), day(4))).estimate!;
  assert.equal(estimate.unmeasuredOre, '0');
  assert.equal(estimate.totalOre, '34800');
});
