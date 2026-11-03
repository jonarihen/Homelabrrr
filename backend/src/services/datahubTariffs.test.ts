import test from 'node:test';
import assert from 'node:assert/strict';
import { assertContiguous, copenhagenWallTimeToUtc, datahubPeriods, formatMicros, hourlyRates, localHour, mergeHourlyRates, sumHourlyRates, type DatahubChargeRecord } from './datahubTariffs.ts';
import { resolveApplicablePrice, type ContractPriceInput, type TariffPriceInput } from './electricityPriceMath.ts';

// Shape of Cerius "Nettarif C time" (30TR_C_ET) as published in Datahub:
// 00–06 low, 06–17 high, 17–21 peak, 21–24 high; rates differ per season.
function blocks(low: number, high: number, peak: number) {
  return Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [`Price${hour + 1}`, hour < 6 ? low : hour < 17 ? high : hour < 21 ? peak : high]));
}
const network: DatahubChargeRecord[] = [
  { ChargeOwner: 'Cerius A/S', ChargeType: 'D03', ChargeTypeCode: '30TR_C_ET', Note: 'Nettarif C', ValidFrom: '2025-10-01T00:00:00', ValidTo: '2026-04-01T00:00:00', ...blocks(0.106463, 0.319389, 0.958167) },
  { ChargeOwner: 'Cerius A/S', ChargeType: 'D03', ChargeTypeCode: '30TR_C_ET', Note: 'Nettarif C', ValidFrom: '2026-04-01T00:00:00', ValidTo: '2026-10-01T00:00:00', ...blocks(0.115336, 0.173004, 0.449811) },
  { ChargeOwner: 'Cerius A/S', ChargeType: 'D03', ChargeTypeCode: '30TR_C_ET', Note: 'Nettarif C time', ValidFrom: '2026-10-01T00:00:00', ValidTo: '2027-01-01T00:00:00', ...blocks(0.115336, 0.346008, 1.038025) },
  // Another code and a subscription row must be ignored.
  { ChargeOwner: 'Cerius A/S', ChargeType: 'D03', ChargeTypeCode: '30TR_BLVT', ValidFrom: '2026-01-01T00:00:00', ValidTo: null, Price1: 9 },
  { ChargeOwner: 'Cerius A/S', ChargeType: 'D01', ChargeTypeCode: '30TR_C_ET', ValidFrom: '2026-01-01T00:00:00', ValidTo: null, Price1: 9 },
];
const flat = (code: string, from: string, to: string, value: number): DatahubChargeRecord => ({ ChargeOwner: 'Energinet', ChargeType: 'D03', ChargeTypeCode: code, ValidFrom: from, ValidTo: to, Price1: value });
const transmission = [flat('40000', '2026-01-01T00:00:00', '2027-01-01T00:00:00', 0.043)];
const systemTariff = [flat('41000', '2026-01-01T00:00:00', '2027-01-01T00:00:00', 0.072)];
const tax = [flat('EA-001', '2026-01-01T00:00:00', '2028-01-01T00:00:00', 0.008)];

const WINDOW_START = copenhagenWallTimeToUtc(2025, 10, 1);
const WINDOW_END = copenhagenWallTimeToUtc(2027, 1, 1);
const netIntervals = mergeHourlyRates(hourlyRates(datahubPeriods(network, '30TR_C_ET'), WINDOW_START, WINDOW_END));
const local = (y: number, m: number, d: number, h: number, minute = 0) => new Date(copenhagenWallTimeToUtc(y, m, d, h).getTime() + minute * 60_000);
const rateAt = (intervals: ReturnType<typeof mergeHourlyRates>, at: Date) => {
  const hits = intervals.filter((item) => item.startUtc <= at && at < item.endUtc);
  assert.equal(hits.length, 1, `exactly one interval covers ${at.toISOString()}`);
  return formatMicros(hits[0].micros);
};

test('local midnight resolves through the Copenhagen offset, including DST days', () => {
  assert.equal(copenhagenWallTimeToUtc(2026, 11, 3).toISOString(), '2026-11-02T23:00:00.000Z');
  assert.equal(copenhagenWallTimeToUtc(2026, 7, 1).toISOString(), '2026-06-30T22:00:00.000Z');
  assert.equal(copenhagenWallTimeToUtc(2026, 3, 29).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(copenhagenWallTimeToUtc(2026, 3, 30).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(copenhagenWallTimeToUtc(2026, 10, 25).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(copenhagenWallTimeToUtc(2026, 10, 26).toISOString(), '2026-10-25T23:00:00.000Z');
  assert.throws(() => copenhagenWallTimeToUtc(2026, 3, 29, 2), /INVALID_LOCAL_TIME/);
});

test('winter 2026 night, day and peak rates switch exactly at local 00, 06, 17 and 21', () => {
  const day = [2026, 11, 3] as const;
  assert.equal(rateAt(netIntervals, local(...day, 0)), '0.115336');
  assert.equal(rateAt(netIntervals, new Date(local(...day, 6).getTime() - 1)), '0.115336');
  assert.equal(rateAt(netIntervals, local(...day, 6)), '0.346008');
  assert.equal(rateAt(netIntervals, new Date(local(...day, 17).getTime() - 1)), '0.346008');
  assert.equal(rateAt(netIntervals, local(...day, 17)), '1.038025');
  assert.equal(rateAt(netIntervals, local(...day, 20, 59)), '1.038025');
  assert.equal(rateAt(netIntervals, local(...day, 21)), '0.346008');
  assert.equal(rateAt(netIntervals, new Date(local(2026, 11, 4, 0).getTime() - 1)), '0.346008');
  assert.equal(rateAt(netIntervals, local(2026, 11, 4, 0)), '0.115336');
  // Local 17:00 in CET is 16:00 UTC.
  assert.ok(netIntervals.some((item) => item.startUtc.toISOString() === '2026-11-03T16:00:00.000Z' && formatMicros(item.micros) === '1.038025'));
});

test('summer blocks follow CEST and use the summer season rates', () => {
  assert.equal(rateAt(netIntervals, local(2026, 7, 15, 5, 59)), '0.115336');
  assert.equal(rateAt(netIntervals, local(2026, 7, 15, 6)), '0.173004');
  assert.equal(rateAt(netIntervals, local(2026, 7, 15, 17)), '0.449811');
  assert.equal(local(2026, 7, 15, 17).toISOString(), '2026-07-15T15:00:00.000Z');
  assert.equal(rateAt(netIntervals, local(2026, 7, 15, 21)), '0.173004');
});

test('season changes take effect at local midnight, never reusing a neighbouring season', () => {
  assert.equal(rateAt(netIntervals, new Date(local(2026, 4, 1, 0).getTime() - 1)), '0.319389');
  assert.equal(rateAt(netIntervals, local(2026, 4, 1, 0)), '0.115336');
  assert.equal(rateAt(netIntervals, local(2026, 4, 1, 17)), '0.449811');
  assert.equal(rateAt(netIntervals, local(2026, 3, 31, 17)), '0.958167');
  assert.equal(rateAt(netIntervals, new Date(local(2026, 10, 1, 0).getTime() - 1)), '0.173004');
  assert.equal(rateAt(netIntervals, local(2026, 10, 1, 6)), '0.346008');
  assert.equal(rateAt(netIntervals, local(2026, 9, 30, 17)), '0.449811');
  assert.equal(rateAt(netIntervals, local(2026, 10, 1, 17)), '1.038025');
});

test('DST days: 23-hour spring day and 25-hour autumn day keep block edges on local time', () => {
  const springDay = netIntervals.filter((item) => item.startUtc >= local(2026, 3, 29, 0) && item.endUtc <= local(2026, 3, 30, 0));
  assert.equal(springDay.reduce((sum, item) => sum + (item.endUtc.getTime() - item.startUtc.getTime()), 0), 23 * 3_600_000);
  assert.equal(rateAt(netIntervals, local(2026, 3, 29, 3)), '0.106463');
  assert.equal(rateAt(netIntervals, local(2026, 3, 29, 6)), '0.319389');
  assert.equal(local(2026, 3, 29, 17).toISOString(), '2026-03-29T15:00:00.000Z');
  assert.equal(rateAt(netIntervals, local(2026, 3, 29, 17)), '0.958167');
  const autumnDay = netIntervals.filter((item) => item.startUtc >= local(2026, 10, 25, 0) && item.endUtc <= local(2026, 10, 26, 0));
  assert.equal(autumnDay.reduce((sum, item) => sum + (item.endUtc.getTime() - item.startUtc.getTime()), 0), 25 * 3_600_000);
  // Local 02:00 happens twice (00:00Z CEST and 01:00Z CET): both are night rate.
  assert.equal(localHour(new Date('2026-10-25T00:00:00Z')), 2);
  assert.equal(localHour(new Date('2026-10-25T01:00:00Z')), 2);
  // 25 October is already in the winter season that starts 1 October.
  assert.equal(rateAt(netIntervals, new Date('2026-10-25T00:30:00Z')), '0.115336');
  assert.equal(rateAt(netIntervals, new Date('2026-10-25T01:30:00Z')), '0.115336');
  assert.equal(rateAt(netIntervals, new Date('2026-10-25T04:59:59Z')), '0.115336'); // 05:59 CET
  assert.equal(rateAt(netIntervals, new Date('2026-10-25T05:00:00Z')), '0.346008'); // 06:00 CET
  assert.equal(rateAt(netIntervals, new Date('2026-10-25T15:59:59Z')), '0.346008'); // 16:59 CET
  assert.equal(rateAt(netIntervals, new Date('2026-10-25T16:00:00Z')), '1.038025'); // 17:00 CET
  assert.equal(rateAt(netIntervals, new Date('2026-10-25T20:00:00Z')), '0.346008'); // 21:00 CET
});

test('expanded intervals cover the whole window with no gap or overlap', () => {
  assert.equal(netIntervals[0].startUtc.getTime(), WINDOW_START.getTime());
  assert.equal(netIntervals[netIntervals.length - 1].endUtc.getTime(), WINDOW_END.getTime());
  assert.doesNotThrow(() => assertContiguous(netIntervals));
  // Four blocks a day (21–24 and 00–06 differ), merged across midnight never.
  assert.ok(netIntervals.every((item) => item.endUtc > item.startUtc));
});

test('a missing period leaves a gap that the contiguity check reports', () => {
  const holed = mergeHourlyRates(hourlyRates(datahubPeriods([network[0], network[2]], '30TR_C_ET'), WINDOW_START, WINDOW_END));
  assert.throws(() => assertContiguous(holed), /TARIFF_INTERVAL_GAP/);
  assert.throws(() => datahubPeriods([network[1], { ...network[2], ValidFrom: '2026-09-01T00:00:00' }], '30TR_C_ET'), /OVERLAPPING_DATAHUB_PERIOD/);
});

test('transmission and system tariffs add up only where both are published', () => {
  const start = copenhagenWallTimeToUtc(2026, 1, 1); const end = copenhagenWallTimeToUtc(2027, 6, 1);
  const combined = mergeHourlyRates(sumHourlyRates(hourlyRates(datahubPeriods(transmission, '40000'), start, end), hourlyRates(datahubPeriods(systemTariff, '41000'), start, end)));
  assert.equal(combined.length, 1);
  assert.equal(formatMicros(combined[0].micros), '0.115000');
  assert.equal(combined[0].endUtc.toISOString(), copenhagenWallTimeToUtc(2027, 1, 1).toISOString());
});

// Full retail price as cost accounting and power control see it.
const contract: ContractPriceInput = { ref: '1', kind: 'spot', area: 'DK2', validFrom: new Date('2024-11-09T23:00:00Z'), validTo: null, fixedRate: null,
  marginRate: '0.000000', vatRate: '0.25', requiredComponents: ['network', 'system', 'tax'], revision: 1 };
const asTariffs = (component: string, intervals: ReturnType<typeof mergeHourlyRates>): TariffPriceInput[] => intervals.map((item) => ({ component, validFrom: item.startUtc, validTo: item.endUtc,
  rate: formatMicros(item.micros), vatIncluded: false, provenance: 'fixture', revision: 1 }));
const sysIntervals = mergeHourlyRates(sumHourlyRates(hourlyRates(datahubPeriods(transmission, '40000'), WINDOW_START, WINDOW_END), hourlyRates(datahubPeriods(systemTariff, '41000'), WINDOW_START, WINDOW_END)));
const taxIntervals = mergeHourlyRates(hourlyRates(datahubPeriods(tax, 'EA-001'), WINDOW_START, WINDOW_END));
const allTariffs = [...asTariffs('network', netIntervals), ...asTariffs('system', sysIntervals), ...asTariffs('tax', taxIntervals)];
const spotAt = (at: Date, rate = '0.500000') => ({ area: 'DK2', startUtc: new Date(Math.floor(at.getTime() / 900_000) * 900_000), endUtc: new Date(Math.floor(at.getTime() / 900_000) * 900_000 + 900_000), rate, revision: 's', fetchedAt: at });

test('total price = (spot + margin + network + system + tax) × 1.25, VAT applied once', () => {
  const cases: Array<[Date, string]> = [
    // 0.5 + 0 + 0.115336 + 0.115 + 0.008 = 0.738336 × 1.25 = 0.922920
    [local(2026, 11, 3, 3), '0.922920'],
    // 0.5 + 0.346008 + 0.123 = 0.969008 × 1.25 = 1.211260
    [local(2026, 11, 3, 6), '1.211260'],
    // 0.5 + 1.038025 + 0.123 = 1.661025 × 1.25 = 2.076281 (rounded half up)
    [local(2026, 11, 3, 17), '2.076281'],
    [local(2026, 11, 3, 21), '1.211260'],
  ];
  for (const [at, expected] of cases) {
    const price = resolveApplicablePrice(at, contract, allTariffs, spotAt(at), 'variable_retail_including_vat');
    assert.equal(price.status, 'valid');
    assert.equal(price.dkk_per_kwh, expected, at.toISOString());
    assert.equal(price.components.filter((item) => item.component === 'vat').length, 1);
    assert.ok(price.components.every((item) => item.component === 'vat' || !item.vat_included));
  }
  // The price's validity never runs past the tariff block, so power control
  // re-reads the price exactly when the block changes.
  const beforePeak = resolveApplicablePrice(local(2026, 11, 3, 16, 50), contract, allTariffs, spotAt(local(2026, 11, 3, 16, 50)), 'variable_retail_including_vat');
  assert.ok(new Date(beforePeak.end_utc!) <= local(2026, 11, 3, 17));
});

test('a missing tariff gives an explicit unavailable price, never a partial one', () => {
  const at = local(2027, 2, 1, 12);
  const price = resolveApplicablePrice(at, contract, allTariffs, spotAt(at), 'variable_retail_including_vat');
  assert.equal(price.status, 'incomplete');
  assert.equal(price.reason, 'TARIFF_NETWORK_MISSING');
  assert.equal(price.dkk_per_kwh, null);
});
