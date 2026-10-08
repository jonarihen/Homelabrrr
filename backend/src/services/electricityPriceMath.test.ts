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
