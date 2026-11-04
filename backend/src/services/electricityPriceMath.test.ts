import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApplicablePrice, type ContractPriceInput } from './electricityPriceMath.ts';
import { parseDayAheadRecords, fetchDayAheadPrices, DayAheadError } from './dayAheadPrices.ts';

const start = new Date('2026-10-08T12:00:00Z');
const end = new Date('2026-10-08T12:15:00Z');
const fixed: ContractPriceInput = { ref: '1', kind: 'fixed_all_in', area: 'DK1', validFrom: start, validTo: end, fixedRate: '2.500000', marginRate: null, vatRate: null, requiredComponents: null, revision: 1 };
const spot: ContractPriceInput = { ...fixed, kind: 'spot', fixedRate: null, marginRate: '0.100000', vatRate: '0.250000', requiredComponents: ['network', 'system', 'tax'] };
const market = { area: 'DK1', startUtc: start, endUtc: end, rate: '-0.200000', revision: 'source1', fetchedAt: new Date('2026-10-07T13:00:00Z') };

test('fixed all-in is a complete retail price and cannot masquerade as spot', () => {
  assert.equal(resolveApplicablePrice(start, fixed, [], null, 'variable_retail_including_vat').dkk_per_kwh, '2.500000');
  assert.equal(resolveApplicablePrice(start, fixed, [], null, 'spot_only_excluding_retail_additions').status, 'incomplete');
});
test('open-ended fixed price has a stable horizon across guarded controller reads', () => {
  const agreement = { ...fixed, validTo: null };
  const first = resolveApplicablePrice(start, agreement, [], null, 'variable_retail_including_vat');
  const rechecked = resolveApplicablePrice(new Date(start.getTime() + 1200), agreement, [], null, 'variable_retail_including_vat');
  assert.equal(first.status, 'valid');
  assert.equal(first.end_utc, '2026-10-09T00:00:00.000Z');
  assert.equal(rechecked.end_utc, first.end_utc);
  assert.equal(rechecked.source_revision, first.source_revision);
});
test('negative spot plus charges and VAT once; explicit spot basis stays raw', () => {
  const tariffs = [
    { component: 'network', validFrom: start, validTo: end, rate: '0.300000', vatIncluded: false, provenance: 'owner', revision: 1 },
    { component: 'system', validFrom: start, validTo: end, rate: '0.100000', vatIncluded: false, provenance: 'owner', revision: 1 },
    { component: 'tax', validFrom: start, validTo: end, rate: '0.050000', vatIncluded: true, provenance: 'owner', revision: 1 },
  ];
  assert.equal(resolveApplicablePrice(start, spot, tariffs, market, 'variable_retail_including_vat').dkk_per_kwh, '0.425000');
  assert.equal(resolveApplicablePrice(start, spot, [], market, 'spot_only_excluding_retail_additions').dkk_per_kwh, '-0.200000');
  assert.equal(resolveApplicablePrice(end, spot, tariffs, market, 'variable_retail_including_vat').status, 'incomplete');
});
test('missing or duplicate required tariffs fail closed and effective boundary trims interval', () => {
  const tariff = { component: 'network', validFrom: new Date('2026-10-08T12:05:00Z'), validTo: end, rate: '0.200000', vatIncluded: false, provenance: 'owner', revision: 1 };
  const configured = { ...spot, requiredComponents: ['network'] };
  assert.equal(resolveApplicablePrice(start, configured, [tariff], market, 'variable_retail_including_vat').status, 'incomplete');
  const price = resolveApplicablePrice(new Date('2026-10-08T12:06:00Z'), configured, [tariff], market, 'variable_retail_including_vat');
  assert.equal(price.start_utc, tariff.validFrom.toISOString());
  assert.equal(resolveApplicablePrice(new Date('2026-10-08T12:06:00Z'), configured, [tariff, tariff], market, 'variable_retail_including_vat').status, 'incomplete');
});
const plus: ContractPriceInput = { ...spot, kind: 'fixed_plus_tariffs', fixedRate: '1.000000' };
const plusTariffs = [
  { component: 'network', validFrom: new Date('2026-10-08T12:05:00Z'), validTo: end, rate: '0.300000', vatIncluded: false, provenance: 'owner', revision: 2 },
  { component: 'system', validFrom: start, validTo: new Date('2026-10-08T12:10:00Z'), rate: '0.100000', vatIncluded: false, provenance: 'owner', revision: 3 },
  { component: 'tax', validFrom: start, validTo: end, rate: '0.050000', vatIncluded: true, provenance: 'owner', revision: 4 },
];
const plusAt = new Date('2026-10-08T12:06:00Z');
test('fixed plus tariffs adds charges and VAT exactly once without spot data', () => {
  const price = resolveApplicablePrice(plusAt, plus, plusTariffs, null, 'variable_retail_including_vat');
  // (1.00 fixed + 0.10 margin + 0.30 network + 0.10 system) * 1.25 + 0.05 VAT-inclusive tax.
  assert.equal(price.status, 'valid');
  assert.equal(price.dkk_per_kwh, '1.925000');
  assert.deepEqual(price.components.map((c) => [c.component, c.dkk_per_kwh, c.vat_included]), [
    ['fixed_energy', '1.000000', false], ['retailer_margin', '0.100000', false], ['network', '0.300000', false], ['system', '0.100000', false], ['tax', '0.050000', true], ['vat', '0.375000', true]]);
  assert.equal(price.start_utc, '2026-10-08T12:05:00.000Z');
  assert.equal(price.end_utc, '2026-10-08T12:10:00.000Z');
  assert.equal(price.known_horizon, price.end_utc);
  assert.equal(price.source_revision, 'fixed:1:2.3.4');
  assert.equal(price.fetched_at, null);
  const noMargin = resolveApplicablePrice(plusAt, { ...plus, marginRate: null }, plusTariffs, null, 'variable_retail_including_vat');
  assert.equal(noMargin.dkk_per_kwh, '1.800000');
  assert.ok(!noMargin.components.some((c) => c.component === 'retailer_margin'));
  // Spot data, if passed, is ignored.
  assert.equal(resolveApplicablePrice(plusAt, plus, plusTariffs, market, 'variable_retail_including_vat').dkk_per_kwh, '1.925000');
});
test('fixed plus tariffs fails closed on missing terms, tariffs, validity and spot basis', () => {
  const reason = (contract: ContractPriceInput, tariffs = plusTariffs, at = plusAt, basis: 'variable_retail_including_vat' | 'spot_only_excluding_retail_additions' = 'variable_retail_including_vat') =>
    resolveApplicablePrice(at, contract, tariffs, null, basis).reason;
  assert.equal(reason(plus, plusTariffs.filter((t) => t.component !== 'system')), 'TARIFF_SYSTEM_MISSING');
  assert.equal(reason(plus, [...plusTariffs, plusTariffs[0]]), 'TARIFF_NETWORK_OVERLAP');
  assert.equal(reason(plus, plusTariffs, start), 'TARIFF_NETWORK_MISSING');
  assert.equal(reason({ ...plus, vatRate: null }), 'RETAIL_TERMS_INCOMPLETE');
  assert.equal(reason({ ...plus, requiredComponents: null }), 'RETAIL_TERMS_INCOMPLETE');
  assert.equal(reason({ ...plus, fixedRate: null }), 'FIXED_RATE_MISSING');
  assert.equal(reason(plus, plusTariffs, end), 'CONTRACT_OUTSIDE_VALIDITY');
  assert.equal(reason(plus, plusTariffs, plusAt, 'spot_only_excluding_retail_additions'), 'SPOT_BASIS_NOT_APPLICABLE');
});
test('open-ended fixed plus tariffs with no required tariffs keeps the stable next-day horizon', () => {
  const price = resolveApplicablePrice(start, { ...plus, validTo: null, requiredComponents: [], marginRate: null }, [], null, 'variable_retail_including_vat');
  assert.equal(price.dkk_per_kwh, '1.250000');
  assert.equal(price.end_utc, '2026-10-09T00:00:00.000Z');
  assert.equal(price.source_revision, 'fixed:1:');
});
test('DayAheadPrices parses 15-minute UTC records and DKK/MWh conversion', () => {
  const rows = parseDayAheadRecords({ records: [{ TimeUTC: '2026-10-08T12:00:00', PriceArea: 'DK1', DayAheadPriceDKK: -200 }, { TimeUTC: '2026-10-08T12:15:00', PriceArea: 'DK1', DayAheadPriceDKK: 2500 }] }, 'DK1');
  assert.equal(rows[0].dkkPerKwh, '-0.200000');
  assert.equal(rows[1].dkkPerKwh, '2.500000');
  assert.equal(rows[0].endUtc.toISOString(), rows[1].startUtc.toISOString());
  assert.throws(() => parseDayAheadRecords({ records: [{ TimeUTC: '2026-10-08T12:00:00', PriceArea: 'DK2', DayAheadPriceDKK: 1 }] }, 'DK1'));
});
test('bounded provider request respects 429 without treating it as free electricity', async () => {
  await assert.rejects(fetchDayAheadPrices('DK1', start, async () => new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    (err: unknown) => err instanceof DayAheadError && err.code === 'RATE_LIMITED' && err.retryAfterMs === 60_000);
});
