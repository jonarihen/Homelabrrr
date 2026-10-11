import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDayAheadPrices, parseDayAheadRecords } from './dayAheadPrices.ts';

test('EDS request uses Copenhagen local range and parses UTC quarter hours in DKK/kWh', async () => {
  let requested: URL | null = null;
  const fetcher = async (input: string | URL) => {
    requested = new URL(String(input));
    return new Response(JSON.stringify({ records: [{ TimeUTC: '2026-10-08T10:00:00', PriceArea: 'DK2', DayAheadPriceDKK: 919.064513 }] }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const rows = await fetchDayAheadPrices('DK2', new Date('2026-10-08T12:00:00Z'), fetcher as typeof fetch);
  assert.equal(requested!.searchParams.get('start'), '2026-10-07T14:00');
  assert.equal(requested!.searchParams.get('end'), '2026-10-09T14:00');
  assert.equal(requested!.searchParams.get('filter'), '{"PriceArea":["DK2"]}');
  assert.equal(rows[0].startUtc.toISOString(), '2026-10-08T10:00:00.000Z');
  assert.equal(rows[0].dkkPerKwh, '0.919065');
});

test('local query range changes offset across Copenhagen autumn DST while record identity stays UTC', async () => {
  let requested: URL | null = null;
  const fetcher = async (input: string | URL) => {
    requested = new URL(String(input));
    return new Response(JSON.stringify({ records: [] }));
  };
  await fetchDayAheadPrices('DK1', new Date('2026-10-25T12:00:00Z'), fetcher as typeof fetch);
  assert.equal(requested!.searchParams.get('start'), '2026-10-24T14:00');
  assert.equal(requested!.searchParams.get('end'), '2026-10-26T13:00');
  const rows = parseDayAheadRecords({ records: [
    { TimeUTC: '2026-10-25T00:00:00', PriceArea: 'DK1', DayAheadPriceDKK: 500 },
    { TimeUTC: '2026-10-25T01:00:00', PriceArea: 'DK1', DayAheadPriceDKK: 500 },
  ] }, 'DK1');
  assert.notEqual(rows[0].startUtc.toISOString(), rows[1].startUtc.toISOString());
});
