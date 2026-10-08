import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { electricityContracts, electricityExtraLoads, users } from '../db/schema/index.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());
const { default: electricityRoutes } = await import('./electricityPricing.ts');
const { calculateLabCost } = await import('../services/electricityPricing.ts');
const { previewMonthlyElectricity } = await import('../services/monthlyElectricity.ts');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.get('x-test-role');
  if (role) req.session = { userId: 1, username: role, isAdmin: role === 'admin',
    reauthenticatedAt: req.get('x-test-reauth') === 'yes' ? Date.now() : undefined } as typeof req.session;
  if (req.get('x-test-api-token') === 'yes') req.apiToken = {} as typeof req.apiToken;
  next();
});
app.use('/api/admin/electricity-pricing', electricityRoutes);
const endpoint = '/api/admin/electricity-pricing/extra-loads';
const valid = { sourceKey: 'rack-switch', label: 'Rack switch overhead', estimatedWatts: '100.000',
  validFrom: '2026-10-01T00:00:00Z', validTo: '2026-10-02T00:00:00Z', provenance: 'measured independently of servers',
  sourceScope: 'incremental_excluding_servers', excludesServerEnergy: true };

test('admin-only dated extra load is priced separately and same-source overlap is rejected', async () => {
  await fixture.db.insert(users).values({ id: 1, username: 'energy-admin-fixture', password: 'unused' });
  const [contract] = await fixture.db.insert(electricityContracts).values({ label: 'fixture fixed all-in', kind: 'fixed_all_in', area: 'DK1',
    valid_from: new Date('2026-10-01T00:00:00Z'), valid_to: new Date('2026-11-01T00:00:00Z'), fixed_dkk_per_kwh: '2.500000',
    provenance: 'test fixture', active: true, fixed_fee_allocation: 'none' }).returning();
  assert.equal((await request(app).get(endpoint)).status, 401);
  assert.equal((await request(app).get(endpoint).set('x-test-role', 'member')).status, 403);
  assert.equal((await request(app).post(endpoint).set('x-test-role', 'admin').send(valid)).body.code, 'REAUTHENTICATION_REQUIRED');
  assert.equal((await request(app).post(endpoint).set('x-test-role', 'admin').set('x-test-reauth', 'yes')
    .send({ ...valid, sourceScope: 'inclusive_upstream' })).status, 400);
  assert.equal((await request(app).post(endpoint).set('x-test-role', 'admin').set('x-test-reauth', 'yes')
    .send({ ...valid, excludesServerEnergy: false })).status, 400);
  const created = await request(app).post(endpoint).set('x-test-role', 'admin').set('x-test-reauth', 'yes').send(valid);
  assert.equal(created.status, 201);
  assert.equal((await request(app).post(endpoint).set('x-test-role', 'admin').set('x-test-reauth', 'yes')
    .send({ ...valid, validFrom: '2026-10-01T12:00:00Z' })).body.error, 'OVERLAPPING_EXTRA_LOAD');
  assert.equal((await request(app).post(endpoint).set('x-test-role', 'admin').set('x-test-reauth', 'yes')
    .send({ ...valid, validFrom: '2026-10-02T00:00:00Z', validTo: '2026-10-03T00:00:00Z' })).status, 201);
  assert.equal((await fixture.db.select().from(electricityExtraLoads)).length, 2);
  const cost = await calculateLabCost(new Date(valid.validFrom), new Date(valid.validTo), String(contract.id));
  assert.equal(cost.totals.length, 0, 'the estimate is not labeled as measured server energy');
  assert.deepEqual(cost.extraLoadCosts.map((row) => [row.quality, row.kwhPriced, row.costOre, row.complete]),
    [['estimated_constant_watts', '2.400000000', '600', true]]);
  const preview = await previewMonthlyElectricity('2026-10', String(contract.id), new Date('2026-10-02T00:00:00Z'));
  assert.equal(preview.serverKwh, '0.000000000');
  assert.equal(preview.estimatedExtraKwh, '2.400000000');
  assert.equal(preview.labKwh, '2.400000000');
  assert.equal(preview.variableCostOre, '600');
  assert.equal(preview.forecast?.status, 'insufficient_data');
  assert.equal(preview.forecast?.estimatedExtraFutureOre, '600');
});
