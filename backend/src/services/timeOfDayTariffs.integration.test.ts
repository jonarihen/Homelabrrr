import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { electricityContracts, electricitySpotPrices, electricityTariffs } from '../db/schema/index.ts';
import { copenhagenWallTimeToUtc, datahubPeriods, formatMicros, hourlyRates, mergeHourlyRates, type DatahubChargeRecord } from './datahubTariffs.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { getApplicablePrice, calculateLabCost, resolvePriceSegments } = await import('./electricityPricing.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

// Winter 2026 Cerius C time-of-day rates, stored the way the importer stores them.
const blocks = Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [`Price${hour + 1}`, hour < 6 ? 0.115336 : hour < 17 ? 0.346008 : hour < 21 ? 1.038025 : 0.346008]));
const cerius: DatahubChargeRecord[] = [{ ChargeType: 'D03', ChargeTypeCode: '30TR_C_ET', ValidFrom: '2026-10-01T00:00:00', ValidTo: '2027-01-01T00:00:00', ...blocks }];
const START = copenhagenWallTimeToUtc(2026, 11, 1);
const END = copenhagenWallTimeToUtc(2026, 11, 8);
const local = (day: number, hour: number) => copenhagenWallTimeToUtc(2026, 11, day, hour);

async function seed(withNetwork = true) {
  const [contract] = await fixture.db.insert(electricityContracts).values({ label: 'tod', kind: 'spot', area: 'DK2', valid_from: START, spot_margin_dkk_per_kwh: '0.000000',
    vat_rate: '0.25', required_components: ['network', 'system', 'tax'], fixed_monthly_ore: 13429, provenance: 'fixture', active: true }).returning();
  const rows = [
    ...(withNetwork ? mergeHourlyRates(hourlyRates(datahubPeriods(cerius, '30TR_C_ET'), START, END)).map((item) => ({ component: 'network', ...item })) : []),
    { component: 'system', startUtc: START, endUtc: END, micros: 115_000n },
    { component: 'tax', startUtc: START, endUtc: END, micros: 8_000n },
  ];
  await fixture.db.insert(electricityTariffs).values(rows.map((row) => ({ contract_id: contract.id, component: row.component, valid_from: row.startUtc, valid_to: row.endUtc,
    dkk_per_kwh: formatMicros(row.micros), vat_included: false, provenance: 'fixture' })));
  return contract;
}

test('stored time-of-day tariffs price night, day and peak for cost and power control', async () => {
  await fixture.db.insert(electricitySpotPrices).values(Array.from({ length: 7 * 96 }, (_, i) => ({ area: 'DK2', start_utc: new Date(START.getTime() + i * 900_000),
    end_utc: new Date(START.getTime() + (i + 1) * 900_000), dkk_per_kwh: '0.500000', source_revision: `r${i}`, fetched_at: START }))).onConflictDoNothing();
  const contract = await seed();
  const policy = { contractRef: String(contract.id), basis: 'variable_retail_including_vat' as const, area: 'DK2' };
  const expectations: Array<[Date, string]> = [[local(3, 0), '0.922920'], [local(3, 5), '0.922920'], [local(3, 6), '1.211260'], [local(3, 16), '1.211260'],
    [local(3, 17), '2.076281'], [local(3, 20), '2.076281'], [local(3, 21), '1.211260'], [local(3, 23), '1.211260']];
  for (const [at, expected] of expectations) {
    // Same call the power-control worker makes (index.ts startPowerControlWorker).
    const price = await getApplicablePrice(at, policy);
    assert.equal(price?.status, 'valid', at.toISOString());
    assert.equal(price?.dkk_per_kwh, expected, at.toISOString());
    assert.equal(price?.components.find((item) => item.component === 'network')?.vat_included, false);
  }
  const justBeforePeak = await getApplicablePrice(new Date(local(3, 17).getTime() - 1), policy);
  assert.equal(justBeforePeak?.dkk_per_kwh, '1.211260');
  assert.ok(new Date(justBeforePeak!.end_utc!) <= local(3, 17));
  // Cost accounting resolves the same segments (no energy rows: nothing priced, but no error).
  const cost = await calculateLabCost(local(3, 0), local(4, 0), String(contract.id));
  assert.equal(cost.totals.length, 0);
  await fixture.db.update(electricityContracts).set({ active: false });
});

test('without a network tariff the price is explicitly unavailable', async () => {
  const contract = await seed(false);
  const price = await getApplicablePrice(local(3, 17), String(contract.id));
  assert.equal(price?.status, 'incomplete');
  assert.equal(price?.reason, 'TARIFF_NETWORK_MISSING');
  assert.equal(price?.dkk_per_kwh, null);
});

test('cost segments split at every tariff block boundary across the 25-hour DST day', () => {
  const winStart = copenhagenWallTimeToUtc(2026, 10, 1); const winEnd = copenhagenWallTimeToUtc(2026, 11, 1);
  const netIntervals = mergeHourlyRates(hourlyRates(datahubPeriods(cerius, '30TR_C_ET'), winStart, winEnd));
  const sysIntervals = [{ startUtc: winStart, endUtc: winEnd, micros: 115_000n }];
  const taxIntervals = [{ startUtc: winStart, endUtc: winEnd, micros: 8_000n }];
  const local = (y: number, m: number, d: number, h: number) => copenhagenWallTimeToUtc(y, m, d, h);
  const dayStart = local(2026, 10, 25, 0); const dayEnd = local(2026, 10, 26, 0);
  const id = 1;
  const row = (component: string, item: ReturnType<typeof mergeHourlyRates>[number], index: number) => ({ id: index, contract_id: id, component, valid_from: item.startUtc, valid_to: item.endUtc,
    dkk_per_kwh: formatMicros(item.micros), vat_included: false, provenance: 'fixture', revision: 1, created_at: new Date() });
  const tariffs = [...netIntervals.map((item, i) => row('network', item, i)), ...sysIntervals.map((item, i) => row('system', item, 10_000 + i)), ...taxIntervals.map((item, i) => row('tax', item, 20_000 + i))]
    .filter((item) => item.valid_from < dayEnd && item.valid_to > dayStart);
  const spots = Array.from({ length: 100 }, (_, i) => ({ id: i, area: 'DK2', start_utc: new Date(dayStart.getTime() + i * 900_000), end_utc: new Date(dayStart.getTime() + (i + 1) * 900_000),
    dkk_per_kwh: '0.500000', source_revision: 's', fetched_at: dayStart }));
  const contractRow = { id, label: 'c', kind: 'spot', area: 'DK2', valid_from: new Date('2024-11-09T23:00:00Z'), valid_to: null, fixed_dkk_per_kwh: null, spot_margin_dkk_per_kwh: '0.000000',
    vat_rate: '0.25', required_components: ['network', 'system', 'tax'], fixed_monthly_ore: 13429, fixed_fee_allocation: 'none', fixed_fee_manual_share: null, revision: 1, active: true,
    provenance: 'fixture', end_reason: null, superseded_by_id: null, created_at: new Date() };
  const segments = resolvePriceSegments({ contracts: [contractRow], tariffs, spots }, dayStart, dayEnd);
  assert.equal(segments.length, 100); // 25 hours of quarter-hour spot
  assert.ok(segments.every((segment) => segment.status === 'valid'));
  const at = (iso: string) => segments.find((segment) => segment.startUtc.toISOString() === iso)!.dkkPerKwh;
  assert.equal(at('2026-10-25T00:00:00.000Z'), '0.922920'); // first 02:00 (CEST), night
  assert.equal(at('2026-10-25T01:00:00.000Z'), '0.922920'); // repeated 02:00 (CET), night
  assert.equal(at('2026-10-25T04:45:00.000Z'), '0.922920'); // 05:45 CET, night
  assert.equal(at('2026-10-25T05:00:00.000Z'), '1.211260'); // 06:00 CET: (0.5 + 0.346008 + 0.123) × 1.25
  assert.equal(at('2026-10-25T16:00:00.000Z'), '2.076281'); // 17:00 CET: (0.5 + 1.038025 + 0.123) × 1.25
  assert.equal(at('2026-10-25T20:00:00.000Z'), '1.211260'); // 21:00 CET
});
