import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { electricityContracts, electricityCostStatements, hardwareConnections, hardwareEnergyIntervals, pveHosts } from '../db/schema/index.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { finalizeMonthlyElectricity, previewMonthlyElectricity } = await import('./monthlyElectricity.ts');
const { calculateLabCost } = await import('./electricityPricing.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

// June 2026 in Europe/Copenhagen (CEST, no DST change inside the month).
const JUNE_START = new Date('2026-05-31T22:00:00Z');
const JUNE_END = new Date('2026-06-30T22:00:00Z');

async function hardware() {
  const [pve] = await fixture.db.insert(pveHosts).values({ name: 'boundary', host: 'pve.boundary.test', token_id: 't', token_secret: 'encrypted' }).returning();
  const [row] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: pve.id, node_ref: `${pve.id}~node`,
    target_host: 'ilo.boundary.test', username: 'u', secret: 'encrypted', collection_enabled: true }).returning();
  return row;
}

test('a month with the next month\'s first interval already ingested is complete and can be finalized', async () => {
  const [contract] = await fixture.db.insert(electricityContracts).values({ label: 'boundary fixed', kind: 'fixed_all_in', area: 'DK2',
    valid_from: new Date('2026-01-01T00:00:00Z'), fixed_dkk_per_kwh: '2.000000', provenance: 'fixture', active: true }).returning();
  const host = await hardware();
  const QUARTER = 900_000;
  const count = (JUNE_END.getTime() - JUNE_START.getTime()) / QUARTER;
  const rows = Array.from({ length: count + 1 }, (_, index) => ({ hardware_id: host.id,
    // The final row is July's first interval, starting exactly at June's exclusive end.
    start_utc: new Date(JUNE_START.getTime() + index * QUARTER), end_utc: new Date(JUNE_START.getTime() + (index + 1) * QUARTER),
    kwh: '0.010000000', covered_seconds: 900, expected_seconds: 900, quality: 'measured', method_version: 'fixture' }));
  for (let index = 0; index < rows.length; index += 1000) await fixture.db.insert(hardwareEnergyIntervals).values(rows.slice(index, index + 1000));

  const cost = await calculateLabCost(JUNE_START, JUNE_END, String(contract.id));
  assert.equal(cost.complete, true);
  assert.equal(cost.totals[0].kwhPriced, '28.800000000');
  assert.equal(cost.totals[0].energyCoveredSeconds, 30 * 86_400);

  const now = new Date('2026-07-02T08:00:00Z');
  const preview = await previewMonthlyElectricity('2026-06', String(contract.id), now);
  assert.equal(preview.variableCostComplete, true);
  assert.equal(preview.variableCostOre, '5760');
  const statement = await finalizeMonthlyElectricity('2026-06', String(contract.id), 'month closed', now);
  assert.equal(statement.revision, 1);
  assert.equal((await fixture.db.select().from(electricityCostStatements)).length, 1);
});
