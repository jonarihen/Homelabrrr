import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { auditLog, electricityContracts, electricityCostStatements, hardwareConnections, hardwareEnergyIntervals, pveHosts, users } from '../db/schema/index.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });
const { default: electricityRoutes } = await import('./electricityPricing.ts');
const { csrfProtection } = await import('../middleware/requestSecurity.ts');
const { energySummary } = await import('../services/energyDashboard.ts');
const { previewMonthlyElectricity } = await import('../services/monthlyElectricity.ts');

const ORIGIN = 'https://portal.example';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.get('x-test-role');
  if (role) req.session = { userId: 1, username: role, isAdmin: role === 'admin',
    reauthenticatedAt: req.get('x-test-reauth') === 'yes' ? Date.now() : undefined } as typeof req.session;
  if (req.get('x-test-api-token') === 'yes') req.apiToken = { id: 1 } as typeof req.apiToken;
  next();
});
// Mounted behind the same global CSRF middleware as production (src/index.ts).
app.use(csrfProtection({ allowedOrigin: ORIGIN }));
app.use('/api/admin/electricity-pricing', electricityRoutes);
const base = '/api/admin/electricity-pricing';
const admin = (req: request.Test) => req.set('x-test-role', 'admin').set('x-test-reauth', 'yes').set('Origin', ORIGIN);

// June 2026 in Europe/Copenhagen.
const JUNE_START = new Date('2026-05-31T22:00:00Z');
const JUNE_END = new Date('2026-06-30T22:00:00Z');
const SWITCH = new Date('2026-06-15T22:00:00Z');

test.before(async () => {
  await fixture.db.insert(users).values({ id: 1, username: 'pricing-admin-fixture', password: 'unused' });
});

test('every pricing route requires an administrator browser session and same-origin mutations', async () => {
  const reads = ['/contracts', '/bills', '/current?contractRef=1', '/extra-loads', '/months/2026-06/statements?contractRef=1'];
  for (const path of reads) {
    assert.equal((await request(app).get(base + path)).status, 401, path);
    assert.equal((await request(app).get(base + path).set('x-test-role', 'member')).status, 403, path);
    assert.equal((await request(app).get(base + path).set('x-test-role', 'admin').set('x-test-api-token', 'yes')).status, 403, path);
  }
  const writes = ['/contracts', '/contracts/1/end', '/contracts/1/supersede', '/contracts/1/deactivate', '/contracts/1/tariffs', '/bills', '/sync', '/months/2026-06/finalize'];
  for (const path of writes) {
    assert.equal((await request(app).post(base + path).set('Origin', ORIGIN)).status, 401, path);
    assert.equal((await request(app).post(base + path).set('x-test-role', 'member').set('Origin', ORIGIN)).status, 403, path);
    const crossSite = await request(app).post(base + path).set('x-test-role', 'admin').set('x-test-reauth', 'yes').set('Origin', 'https://evil.example');
    assert.equal(crossSite.body.code, 'ORIGIN_NOT_ALLOWED', path);
    const noOrigin = await request(app).post(base + path).set('x-test-role', 'admin').set('x-test-reauth', 'yes');
    assert.equal(noOrigin.status, 403, path);
  }
  // Sensitive writes also demand a recent re-authentication.
  for (const path of ['/contracts', '/contracts/1/end', '/contracts/1/supersede', '/bills', '/months/2026-06/finalize']) {
    const stale = await request(app).post(base + path).set('x-test-role', 'admin').set('Origin', ORIGIN).send({});
    assert.equal(stale.body.code, 'REAUTHENTICATION_REQUIRED', path);
  }
});

test('superseding a contract mid-month prices each part under its own agreement and protects the finalized month', async () => {
  const created = await admin(request(app).post(`${base}/contracts`)).send({ label: 'Supplier A', kind: 'fixed_all_in', area: 'DK2',
    validFrom: '2026-01-01T00:00:00Z', fixedDkkPerKwh: '2.000000', fixedMonthlyOre: 3000, fixedFeeAllocation: 'manual_share', fixedFeeManualShare: '0.500000',
    provenance: 'fixture agreement', active: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const a = created.body.id;
  assert.equal((await admin(request(app).post(`${base}/contracts/${a}/supersede`)).send({ effectiveAt: SWITCH.toISOString(), successor: { label: 'Supplier B' } })).body.error, 'INVALID_REASON');
  const superseded = await admin(request(app).post(`${base}/contracts/${a}/supersede`)).send({ effectiveAt: SWITCH.toISOString(), reason: 'switched supplier',
    successor: { label: 'Supplier B', kind: 'fixed_all_in', area: 'DK2', fixedDkkPerKwh: '3.000000', fixedMonthlyOre: 6000,
      fixedFeeAllocation: 'manual_share', fixedFeeManualShare: '0.500000', provenance: 'fixture agreement B' } });
  assert.equal(superseded.status, 201, JSON.stringify(superseded.body));
  const b = superseded.body.successor.id;
  assert.equal(superseded.body.previous.valid_to, SWITCH.toISOString());
  assert.equal(superseded.body.previous.superseded_by_id, b);
  assert.equal(superseded.body.previous.end_reason, 'switched supplier');
  assert.equal(superseded.body.previous.active, true, 'an ended contract still prices its own history');
  const [audit] = await fixture.db.select().from(auditLog).where(eq(auditLog.action, 'electricity_contract_superseded'));
  assert.match(String(audit.detail), /reason=switched supplier/);
  // An ended contract cannot be extended or re-ended past its end.
  assert.equal((await admin(request(app).post(`${base}/contracts/${a}/end`)).send({ validTo: '2026-07-01T00:00:00Z', reason: 'later' })).body.error, 'INVALID_CONTRACT_END');

  const [pve] = await fixture.db.insert(pveHosts).values({ name: 'succession', host: 'pve.succession.test', token_id: 't', token_secret: 'encrypted' }).returning();
  const [hardware] = await fixture.db.insert(hardwareConnections).values({ pve_host_id: pve.id, node_ref: `${pve.id}~node`,
    target_host: 'ilo.succession.test', username: 'u', secret: 'encrypted', collection_enabled: true }).returning();
  const quarters = (JUNE_END.getTime() - JUNE_START.getTime()) / 900_000;
  const rows = Array.from({ length: quarters }, (_, index) => ({ hardware_id: hardware.id, start_utc: new Date(JUNE_START.getTime() + index * 900_000),
    end_utc: new Date(JUNE_START.getTime() + (index + 1) * 900_000), kwh: '0.010000000', covered_seconds: 900, expected_seconds: 900, quality: 'measured', method_version: 'fixture' }));
  for (let index = 0; index < rows.length; index += 1000) await fixture.db.insert(hardwareEnergyIntervals).values(rows.slice(index, index + 1000));

  const now = new Date('2026-07-02T08:00:00Z');
  const preview = await previewMonthlyElectricity('2026-06', String(b), now);
  assert.deepEqual(preview.contractRefs, [String(a), String(b)]);
  assert.equal(preview.statementContractRef, String(a));
  assert.equal(preview.variableCostComplete, true);
  // 14.4 kWh at 2.00 + 14.4 kWh at 3.00.
  assert.equal(preview.variableCostOre, '7200');
  // Each monthly fee is allocated for its own half of the month: 1500 * 0.5 + 3000 * 0.5.
  assert.equal(preview.allocatedFixedFeeOre, '2250');
  assert.equal(preview.fixedFeeStatus, 'known');

  const finalized = await admin(request(app).post(`${base}/months/2026-06/finalize`)).send({ contractRef: String(b), reason: 'June closed' });
  assert.equal(finalized.status, 201, JSON.stringify(finalized.body));
  assert.equal(finalized.body.contract_id, a, 'one statement per month, stored under the month anchor');
  assert.equal((await admin(request(app).post(`${base}/contracts/${b}/end`)).send({ validTo: '2026-06-20T00:00:00Z', reason: 'typo' })).body.error, 'FINALIZED_PERIOD');

  // Closed months are read from the finalized statement, not recalculated.
  await fixture.db.delete(hardwareEnergyIntervals).where(eq(hardwareEnergyIntervals.start_utc, JUNE_START));
  const summary = await energySummary('2026-06', now);
  assert.equal(summary.cost.status, 'finalized');
  assert.equal(summary.cost.actualOre, '9450');
  assert.equal(summary.cost.statementRevision, 1);
  assert.equal(summary.cost.forecastOre, null);

  // A withdrawn contract is never used for dashboard cost.
  await admin(request(app).post(`${base}/contracts/${a}/deactivate`)).send({});
  const withdrawn = await energySummary('2026-06', now);
  assert.notEqual(withdrawn.cost.actualOre, '9450');
});

test('incomplete months finalize only with an explicit partial-coverage acknowledgement', async () => {
  const [contract] = await fixture.db.select().from(electricityContracts).where(eq(electricityContracts.label, 'Supplier B'));
  const empty = await admin(request(app).post(`${base}/months/2026-05/finalize`)).send({ contractRef: String(contract.id), reason: 'May' });
  assert.equal(empty.body.error, 'Incomplete calculation cannot be finalized');
  assert.equal((await admin(request(app).post(`${base}/months/2026-05/finalize`)).send({ contractRef: String(contract.id), reason: 'May', acknowledgePartial: 'yes' })).body.error, 'INVALID_ACKNOWLEDGEMENT');
  const acknowledged = await admin(request(app).post(`${base}/months/2026-05/finalize`)).send({ contractRef: String(contract.id), reason: 'May: telemetry not installed yet', acknowledgePartial: true });
  assert.equal(acknowledged.status, 201, JSON.stringify(acknowledged.body));
  assert.equal(acknowledged.body.calculation.partialAcknowledged, true);
  assert.equal(acknowledged.body.calculation.missingCoverage.variableCostComplete, false);
  const statements = await fixture.db.select().from(electricityCostStatements).where(eq(electricityCostStatements.contract_id, acknowledged.body.contract_id));
  assert(statements.some((row) => row.id === acknowledged.body.id));
});
