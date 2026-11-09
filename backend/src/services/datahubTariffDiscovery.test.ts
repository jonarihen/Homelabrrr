import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTariffSources, ENERGINET_GLN } from './datahubTariffDiscovery.ts';

const GRID = '5790000705184';
const NOW = new Date('2026-11-09T12:00:00Z');
const tariff = (owner: string, priceId: string, name: string, prices: number[] = [0.1], extra: Record<string, unknown> = {}) => ({
  owner, priceId, name, validFromDate: '2020-01-01T00:00:00.000Z', validToDate: null, periodType: 'P1D',
  prices: prices.map((price, index) => ({ position: String(index + 1), price })), ...extra,
});
const codes = (list: Array<{ code: string }>) => list.map((item) => item.code);

test('classifies a real-shaped snapshot into network, system and tax sources', () => {
  const { sources, networkOwners } = discoverTariffSources({ fees: [], subscriptions: [{ name: 'ignored' }], tariffs: [
    tariff(ENERGINET_GLN, '41000', 'Systemtarif'), tariff(ENERGINET_GLN, '40000', 'Transmissions nettarif'), tariff(ENERGINET_GLN, 'EA-001', 'Elafgift'),
    tariff(GRID, '30TR_C_ET', 'Nettarif C', [0.1, 0.3]), tariff(GRID, '30RE_C_ET', 'Rabat Nettarif C', [0, 0]),
  ] }, NOW);
  assert.deepEqual(codes(sources.system), ['41000', '40000']);
  assert.deepEqual(codes(sources.tax), ['EA-001']);
  assert.deepEqual(codes(sources.network), ['30TR_C_ET', '30RE_C_ET']);
  assert.deepEqual(networkOwners, [GRID]);
  assert.deepEqual(sources.network.map((item) => item.zeroRated), [false, true]);
  assert.equal(sources.network[0].gln, GRID);
});

test('ignores charges outside their validity and repeated identities', () => {
  const { sources } = discoverTariffSources({ tariffs: [
    tariff(GRID, 'OLD', 'Expired', [1], { validToDate: '2026-01-01T00:00:00.000Z' }),
    tariff(GRID, 'NEXT', 'Future', [1], { validFromDate: '2027-01-01T00:00:00.000Z' }),
    tariff(GRID, 'NOW', 'Current'), tariff(GRID, 'NOW', 'Current again'),
    tariff(GRID, 'ENDS', 'Ends later', [1], { validToDate: '2027-01-01T00:00:00.000Z' }),
  ] }, NOW);
  assert.deepEqual(codes(sources.network), ['NOW', 'ENDS']);
});

test('a second non-Energinet owner leaves the network unresolved instead of guessing', () => {
  const { sources, networkOwners } = discoverTariffSources({ tariffs: [tariff(GRID, 'A', 'Grid'), tariff('5790000000000', 'B', 'Retailer add-on')] }, NOW);
  assert.deepEqual(sources.network, []);
  assert.equal(networkOwners.length, 2);
});

test('an empty price list is not treated as zero-rated', () => {
  const { sources } = discoverTariffSources({ tariffs: [tariff(GRID, 'A', 'Grid', [])] }, NOW);
  assert.equal(sources.network[0].zeroRated, false);
});

test('rejects snapshots without usable charge identities', () => {
  for (const payload of [null, {}, { tariffs: 'x' }, { tariffs: [tariff('Cerius A/S', 'A', 'Grid')] }, { tariffs: [tariff(GRID, '', 'Grid')] }, { tariffs: [tariff(GRID, 'A', 'Grid', [1], { validFromDate: undefined })] }]) {
    assert.throws(() => discoverTariffSources(payload, NOW), /INVALID_CHARGE_SNAPSHOT/);
  }
});
