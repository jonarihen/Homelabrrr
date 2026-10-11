import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { electricityContracts, hardwareConnections, hardwareEnergyIntervals, pveHosts } from '../db/schema/index.ts';
import { eq } from 'drizzle-orm';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { energySummary, energyHistory } = await import('./energyDashboard.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

test('private summary uses configured fixed retail price and marks missing server evidence partial', async () => {
  await fixture.db.insert(electricityContracts).values({
    label: 'fixture fixed tariff', kind: 'fixed_all_in', area: 'DK2',
    valid_from: new Date('2026-01-01T00:00:00Z'), fixed_dkk_per_kwh: '2.500000',
    provenance: 'test fixture', active: true,
  });
  const summary = await energySummary('2026-10', new Date('2026-10-08T12:00:00Z'));
  assert.equal(summary.price.status, 'valid');
  assert.equal(summary.price.orePerKwh, 250);
  assert.notEqual(summary.cost.status, 'calculated');
  assert.equal(summary.telemetry.energyStatus, 'unavailable');
  assert.equal(summary.funding.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(summary), /fixture fixed tariff|provenance|selected_meter_id|refresh_token/);
});

test('historical server cost uses its effective contract while current price uses the current one', async () => {
  await fixture.db.update(electricityContracts).set({ fixed_dkk_per_kwh: '2.000000', valid_to: new Date('2026-10-01T00:00:00Z'), active: false })
    .where(eq(electricityContracts.label, 'fixture fixed tariff'));
  await fixture.db.insert(electricityContracts).values({
    label: 'current contract', kind: 'fixed_all_in', area: 'DK2', valid_from: new Date('2026-10-01T00:00:00Z'),
    fixed_dkk_per_kwh: '3.000000', provenance: 'test fixture', active: true,
  });
  const [pve] = await fixture.db.insert(pveHosts).values({ name: 'test', host: 'pve.test', token_id: 'test', token_secret: 'encrypted' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: pve.id, node_ref: `${pve.id}~node`,
    target_host: 'ilo.test', username: 'test', secret: 'encrypted', collection_enabled: true }).returning();
  await fixture.db.insert(hardwareEnergyIntervals).values({ hardware_id: hardware.id,
    start_utc: new Date('2026-09-10T12:00:00Z'), end_utc: new Date('2026-09-10T12:15:00Z'),
    kwh: '1.000000000', covered_seconds: 900, expected_seconds: 900, quality: 'measured', method_version: 'fixture' });
  const summary = await energySummary('2026-09', new Date('2026-10-08T12:00:00Z'));
  assert.equal(summary.price.orePerKwh, 300);
  assert.equal(summary.cost.actualOre, '200');
  assert.equal(summary.cost.status, 'partial');
  const history = await energyHistory('24h', new Date('2026-09-10T12:30:00Z'));
  assert.equal(history.energy.unit, 'kWh');
  assert.equal(history.energy.method, 'integrated_server_input');
  assert.equal(history.energy.points.length, 1);
  assert.equal(history.energy.points[0].kwh, 1);
  assert.equal(history.energy.points[0].coveredSeconds, 900);
});
