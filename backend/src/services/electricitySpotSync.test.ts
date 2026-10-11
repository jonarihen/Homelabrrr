import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { electricityContracts, electricitySpotPrices } from '../db/schema/index.ts';
import type { DayAheadRow } from './dayAheadPrices.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { syncPublishedSpotPrices, missingSpotDays } = await import('./electricityPricing.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

const QUARTER = 900_000;
const HOUR = 3_600_000;
// Fixture provider: quarter-hour prices for at +/- 24 h, like the real request window.
const requested: Date[] = [];
function fixtureFetcher(fail: (at: Date) => Error | null = () => null) {
  return async (area: 'DK1' | 'DK2', at: Date): Promise<DayAheadRow[]> => {
    requested.push(at);
    const error = fail(at);
    if (error) throw error;
    const first = Math.ceil((at.getTime() - 24 * HOUR) / QUARTER) * QUARTER;
    return Array.from({ length: 192 }, (_, index) => ({ area, startUtc: new Date(first + index * QUARTER), endUtc: new Date(first + (index + 1) * QUARTER),
      dkkPerKwh: '0.500000', sourceRevision: `fixture-${first + index * QUARTER}` }));
  };
}

test('outage gaps in the recent spot cache are re-fetched in bounded batches', async () => {
  await fixture.db.insert(electricityContracts).values({ label: 'spot', kind: 'spot', area: 'DK2', valid_from: new Date('2026-10-01T00:00:00Z'),
    spot_margin_dkk_per_kwh: '0.000000', vat_rate: '0.250000', required_components: [], provenance: 'fixture', active: true });
  const now = new Date('2026-10-08T12:00:00Z');
  const result = await syncPublishedSpotPrices(now, fixtureFetcher());
  assert.equal(result.backfilledDays, 3);
  assert.deepEqual(requested.map((at) => at.toISOString()), ['2026-10-08T12:00:00.000Z', '2026-10-07T12:00:00.000Z', '2026-10-06T12:00:00.000Z', '2026-10-05T12:00:00.000Z']);
  // Gap detection never reaches before the earliest spot contract.
  const missing = await missingSpotDays('DK2', now, new Date('2026-10-01T00:00:00Z'));
  assert.deepEqual(missing.map((day) => day.toISOString().slice(0, 10)), ['2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']);

  // The six-hour gate holds; the next run continues with older gaps.
  requested.length = 0;
  assert.deepEqual(await syncPublishedSpotPrices(new Date(now.getTime() + HOUR), fixtureFetcher()), { imported: 0, backfilledDays: 0 });
  assert.equal(requested.length, 0);
  await syncPublishedSpotPrices(new Date(now.getTime() + 6 * HOUR), fixtureFetcher());
  assert.deepEqual(requested.slice(1).map((at) => at.toISOString().slice(0, 10)), ['2026-10-04', '2026-10-03', '2026-10-02']);
});

test('a provider rate limit stops the backfill and is honoured; prices are never fabricated', async () => {
  requested.length = 0;
  const before = (await fixture.db.select().from(electricitySpotPrices)).length;
  const later = new Date('2026-10-09T00:00:00Z');
  const limited = Object.assign(new Error('limited'), { retryAfterMs: 2 * HOUR });
  const result = await syncPublishedSpotPrices(later, fixtureFetcher((at) => at.getTime() !== later.getTime() ? limited : null));
  assert.equal(result.backfilledDays, 0);
  assert.equal(requested.length, 2, 'the first rate-limited backfill request ends the run');
  const rows = await fixture.db.select().from(electricitySpotPrices);
  assert(rows.length > before, 'the current window was still stored');
  assert(rows.every((row) => row.dkk_per_kwh === '0.500000'), 'nothing is filled in for unfetched gaps');
  requested.length = 0;
  assert.deepEqual(await syncPublishedSpotPrices(new Date(later.getTime() + 3 * HOUR), fixtureFetcher()), { imported: 0, backfilledDays: 0 }, 'six-hour gate');
  await syncPublishedSpotPrices(new Date(later.getTime() + 7 * HOUR), fixtureFetcher());
  assert(requested.length > 0, 'resumes after Retry-After and the gate');
});
