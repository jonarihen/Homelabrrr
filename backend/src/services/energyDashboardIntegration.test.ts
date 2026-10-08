import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { electricityContracts } from '../db/schema/index.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { energySummary } = await import('./energyDashboard.ts');
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
