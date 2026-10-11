import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { eloverblikChargeObservations, eloverblikChargeSnapshots, eloverblikConnections, eloverblikIntervals, notificationWebhooks } from '../db/schema/index.ts';
import { FIXTURE_METER, OTHER_FIXTURE_METER, chargesEnvelope, fixtureAccessToken, meterListEnvelope, timeSeriesEnvelope } from '../testUtils/eloverblikFixtures.ts';

// Every outbound request goes through this fake; nothing reaches ElOverblik.
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const calls: Array<{ url: URL; init: RequestInit }> = [];
let routes: { token?: Handler; meters?: Handler; series?: Handler; charges?: Handler } = {};
const webhookPosts: Array<{ url: string; body: unknown }> = [];
const fixtureFetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if (url.origin === 'https://discord.example') { webhookPosts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
  calls.push({ url, init });
  assert.equal(url.origin, 'https://api.eloverblik.dk');
  assert.equal(init.redirect, 'error');
  const path = url.pathname.replace('/customerapi/api', '');
  const route = path === '/token' ? routes.token : path.startsWith('/meteringpoints/meteringpoints') ? routes.meters
    : path.startsWith('/meterdata/gettimeseries/') ? routes.series : path === '/meteringpoints/meteringpoint/getcharges' ? routes.charges : undefined;
  if (!route) return new Response('not found', { status: 404 });
  return route(url, init);
}) as typeof fetch;
globalThis.fetch = fixtureFetch;

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
process.env.SECRET_ENCRYPTION_KEY = '66'.repeat(32);
process.env.PORTAL_BASE_URL = 'https://portal.example';
const { manualSyncSelectedMeter, syncSelectedMeter, saveRefreshToken, selectMeter, energyDataStatus, disconnect } = await import('./eloverblik.ts');
const { ElOverblikClient } = await import('./eloverblikClient.ts');
const { encryptSecret } = await import('../utils/secrets.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

const NOW = new Date('2026-10-08T15:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const seriesRange = (url: URL) => { const [from, to] = url.pathname.split('/').slice(-3, -1); return { from, to }; };
const seriesWith = (meter: string, dataFrom: string, quantity?: () => unknown): Handler => (url) => {
  const { from, to } = seriesRange(url);
  return Response.json(timeSeriesEnvelope(meter, from, to, { dataFrom, ...(quantity ? { quantity } : {}) }));
};
const defaultRoutes = () => ({
  token: () => Response.json({ result: fixtureAccessToken(Math.floor(NOW.getTime() / 1000) + 365 * 86_400) }),
  meters: () => Response.json(meterListEnvelope([{ id: FIXTURE_METER }, { id: OTHER_FIXTURE_METER, hasRelation: false }])),
  series: seriesWith(FIXTURE_METER, '2026-10-01'),
  charges: () => Response.json(chargesEnvelope(FIXTURE_METER, '0.10')),
});
const state = async () => (await fixture.db.select().from(eloverblikConnections).where(eq(eloverblikConnections.id, 1)))[0];
const intervalCount = async () => (await fixture.db.select().from(eloverblikIntervals)).length;
const intervalAt = async (iso: string) => (await fixture.db.select().from(eloverblikIntervals).where(eq(eloverblikIntervals.interval_start, new Date(iso))))[0];
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(check(), label);
}

test('manual meter resync is rate-limited by durable last-attempt time', async () => {
  await fixture.db.insert(eloverblikConnections).values({ id: 1, enabled: false, last_attempt_at: new Date(NOW.getTime() - 90_000) });
  await assert.rejects(manualSyncSelectedMeter(NOW), (err: any) => {
    assert.equal(err.code, 'RATE_LIMIT');
    assert.equal(err.retryAfterMs, 210_000);
    return true;
  });
  assert.deepEqual(await manualSyncSelectedMeter(new Date(NOW.getTime() + 5 * 60_000)), { status: 'disabled' });
});

test('owner token -> meter selection -> resumable backfill -> periodic refresh, without double counting', async () => {
  routes = defaultRoutes();
  await saveRefreshToken('fixture-refresh-token');
  assert.equal((await energyDataStatus()).enabled, false, 'saving a token does not start ingestion');
  await assert.rejects(selectMeter(OTHER_FIXTURE_METER, 'household'), /METER_UNAUTHORIZED/);
  await selectMeter(FIXTURE_METER, 'household');
  calls.length = 0;
  let chunks = 0;
  for (let result: any = { nextCursor: true }; result.nextCursor; chunks++) {
    result = await syncSelectedMeter(NOW);
    assert.equal(result.status, 'ok');
    assert(chunks < 20, 'backfill is bounded');
  }
  assert.equal(chunks, 14, '395 days in 30-day chunks');
  const seriesCalls = calls.filter((call) => call.url.pathname.includes('gettimeseries'));
  assert.equal(seriesRange(seriesCalls[0].url).from, '2025-09-08');
  assert.equal(seriesRange(seriesCalls.at(-1)!.url).to, '2026-10-08');
  assert(seriesCalls.every((call) => JSON.parse(String(call.init.body)).meteringPoints.meteringPoint[0] === FIXTURE_METER));
  assert.equal(calls.filter((call) => call.url.pathname.endsWith('/token')).length, 1, 'one access token serves the whole backfill');
  // 2026-10-01..07 Copenhagen days of hourly data.
  assert.equal(await intervalCount(), 7 * 24);
  const status = await energyDataStatus();
  assert.equal(status.selectedMeter, '••••0001');
  assert.equal(status.backfill?.inProgress, false);
  assert.equal(new Date(status.coverage!.earliestIntervalStart!).toISOString(), '2026-09-30T22:00:00.000Z');
  assert.equal(status.charges?.available, true);
  assert.deepEqual(status.gaps, []);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(FIXTURE_METER));

  // Periodic refresh rechecks the recent 7 days only and upserts corrections.
  calls.length = 0;
  routes.series = seriesWith(FIXTURE_METER, '2026-10-01', () => '0.500');
  assert.equal((await syncSelectedMeter(new Date(NOW.getTime() + 6 * HOUR))).status, 'ok');
  assert.deepEqual(seriesRange(calls.find((call) => call.url.pathname.includes('gettimeseries'))!.url), { from: '2026-10-01', to: '2026-10-08' });
  assert.equal(await intervalCount(), 7 * 24, 'overlap and repeated runs do not duplicate intervals');
  assert.equal((await intervalAt('2026-10-05T00:00:00Z')).energy_kwh, '0.500000');
});

test('charge revisions A -> B -> A keep every observed version in order', async () => {
  for (const [index, tariff] of ['0.20', '0.10'].entries()) {
    routes.charges = () => Response.json(chargesEnvelope(FIXTURE_METER, tariff));
    await syncSelectedMeter(new Date(NOW.getTime() + (12 + index * 6) * HOUR));
  }
  const snapshots = await fixture.db.select().from(eloverblikChargeSnapshots).orderBy(eloverblikChargeSnapshots.id);
  const observations = await fixture.db.select().from(eloverblikChargeObservations).orderBy(eloverblikChargeObservations.first_observed_at);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(observations.map((row) => row.snapshot_id), [snapshots[0].id, snapshots[1].id, snapshots[0].id]);
  assert.equal(observations[0].last_observed_at.toISOString(), new Date(NOW.getTime() + 6 * HOUR).toISOString(), 'unchanged content extends the observation');

  // Missing or failing charges never stop consumption ingestion.
  routes.charges = () => new Response('unavailable', { status: 500 });
  routes.series = seriesWith(FIXTURE_METER, '2026-10-01', () => '0.750');
  assert.equal((await syncSelectedMeter(new Date(NOW.getTime() + 24 * HOUR))).status, 'ok');
  assert.equal((await intervalAt('2026-10-05T00:00:00Z')).energy_kwh, '0.750000');
  assert.equal((await fixture.db.select().from(eloverblikChargeObservations)).length, 3);
});

test('credential replacement during an import aborts that import without writing', async () => {
  const before = await intervalCount();
  routes = defaultRoutes();
  routes.series = async (url) => {
    const current = await state();
    await fixture.db.update(eloverblikConnections).set({ config_version: current.config_version + 1 }).where(eq(eloverblikConnections.id, 1));
    return seriesWith(FIXTURE_METER, '2026-09-25')(url, {});
  };
  await assert.rejects(syncSelectedMeter(new Date(NOW.getTime() + 30 * HOUR)), /CONFIG_CHANGED/);
  assert.equal(await intervalCount(), before);
  assert.equal((await state()).last_error_code, null, 'a superseded configuration records no error');
});

test('503/429 Retry-After (seconds and HTTP-date) defers scheduled and manual syncs and survives restart', async () => {
  routes = defaultRoutes();
  const failedAt = new Date(NOW.getTime() + 40 * HOUR);
  routes.series = () => new Response('busy', { status: 503, headers: { 'Retry-After': '7200' } });
  await assert.rejects(syncSelectedMeter(failedAt), /HTTP_503/);
  let row = await state();
  assert.equal(row.retry_after_until?.toISOString(), new Date(failedAt.getTime() + 2 * HOUR).toISOString());
  assert.equal(row.consecutive_failures, 1);
  calls.length = 0;
  // Durable state: a new process (fresh client) still defers.
  const restarted = new ElOverblikClient({ fetcher: fixtureFetch });
  assert.equal((await syncSelectedMeter(new Date(failedAt.getTime() + HOUR), { client: restarted })).status, 'deferred');
  await assert.rejects(manualSyncSelectedMeter(new Date(failedAt.getTime() + HOUR), null, restarted), /RATE_LIMITED/);
  assert.equal(calls.length, 0, 'deferred work does not contact the provider');

  const later = new Date(failedAt.getTime() + 2 * HOUR + 1000);
  routes.series = () => new Response('slow down', { status: 429, headers: { 'Retry-After': new Date(later.getTime() + 3 * HOUR).toUTCString() } });
  await assert.rejects(syncSelectedMeter(later, { client: new ElOverblikClient({ fetcher: fixtureFetch, now: () => later.getTime() }) }), /RATE_LIMITED/);
  row = await state();
  assert.equal(Math.round((row.retry_after_until!.getTime() - later.getTime()) / 1000), 3 * 3600);
  assert.equal(row.consecutive_failures, 2);
  assert(row.next_attempt_at! >= row.retry_after_until!, 'backoff never undercuts the provider hint');

  routes = defaultRoutes();
  assert.equal((await syncSelectedMeter(new Date(later.getTime() + 4 * HOUR))).status, 'ok');
  row = await state();
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.retry_after_until, null);
});

test('a permanently failing backfill chunk is skipped after bounded attempts and can be re-imported', async () => {
  const cursor = new Date('2026-09-01T00:00:00Z');
  await fixture.db.update(eloverblikConnections).set({ import_cursor: cursor }).where(eq(eloverblikConnections.id, 1));
  routes = defaultRoutes();
  routes.series = (url, init) => {
    if (seriesRange(url).from === '2026-09-01') return Response.json({ result: [{ id: FIXTURE_METER, success: false, errorCode: 30000, errorText: 'SyntheticFailure' }] });
    return seriesWith(FIXTURE_METER, '2026-10-01')(url, init);
  };
  let at = new Date(NOW.getTime() + 3 * DAY);
  await assert.rejects(syncSelectedMeter(at), /UPSTREAM_30000/);
  at = new Date(at.getTime() + DAY);
  await assert.rejects(syncSelectedMeter(at), /UPSTREAM_30000/);
  assert.equal((await state()).chunk_failures, 2);
  at = new Date(at.getTime() + DAY);
  assert.equal((await syncSelectedMeter(at) as { status: string }).status, 'chunk_skipped');
  let row = await state();
  assert.equal(row.import_cursor?.toISOString(), '2026-10-01T00:00:00.000Z', 'the backfill moves past the failing chunk');
  assert.deepEqual((row.skipped_ranges as Array<{ from: string; to: string; code: string }>).map((range) => [range.from, range.to, range.code]),
    [['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'UPSTREAM_30000']]);
  assert.equal((await energyDataStatus()).skippedRanges?.length, 1);

  // A later explicit period resync closes the recorded gap.
  routes.series = seriesWith(FIXTURE_METER, '2026-09-01');
  at = new Date(at.getTime() + DAY);
  assert.equal((await manualSyncSelectedMeter(at, { from: cursor, to: new Date('2026-10-01T00:00:00Z') }) as { status: string }).status, 'ok');
  row = await state();
  assert.deepEqual(row.skipped_ranges, []);
  assert.equal(row.import_cursor?.toISOString(), '2026-10-01T00:00:00.000Z', 'a period resync does not move the backfill cursor');
  assert(await intervalAt('2026-09-10T00:00:00Z'));
});

test('revoked refresh token pauses polling and sends one private notification', async () => {
  await fixture.db.insert(notificationWebhooks).values({ name: 'owner', url: encryptSecret('https://discord.example/hook')!, event_types: ['energy.meter_attention'] });
  routes = defaultRoutes();
  routes.token = () => new Response('revoked', { status: 401 });
  const fresh = new ElOverblikClient({ fetcher: fixtureFetch });
  const at = new Date(NOW.getTime() + 10 * DAY);
  await assert.rejects(syncSelectedMeter(at, { client: fresh }), /RECONNECT_REQUIRED/);
  assert.equal((await state()).attention_code, 'RECONNECT_REQUIRED');
  calls.length = 0;
  for (const offset of [1, 2]) {
    assert.deepEqual(await syncSelectedMeter(new Date(at.getTime() + offset * DAY), { client: fresh }), { status: 'attention_required', code: 'RECONNECT_REQUIRED' });
  }
  assert.equal(calls.length, 0, 'no further token use while reconnect is required');
  await waitFor(() => webhookPosts.length === 1, 'one notification is delivered');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(webhookPosts.length, 1, 'notification is deduplicated');
  assert.doesNotMatch(JSON.stringify(webhookPosts[0].body), new RegExp(`${FIXTURE_METER}|fixture-refresh-token|eyJ`));
  assert.equal((await energyDataStatus()).attention?.code, 'RECONNECT_REQUIRED');

  // Replacing the credential clears the state and requires an explicit meter choice again.
  routes = defaultRoutes();
  await saveRefreshToken('replacement-refresh-token');
  const replaced = await state();
  assert.equal(replaced.attention_code, null);
  assert.equal(replaced.selected_meter_id, null);
  assert.equal(replaced.last_success_at, null);
});

test('unauthorized and missing meters pause polling; a different meter restarts its own backfill', async () => {
  routes = defaultRoutes();
  await selectMeter(FIXTURE_METER, 'household');
  await fixture.db.update(eloverblikConnections).set({ last_success_at: NOW, latest_interval_end: new Date('2026-10-08T00:00:00Z') }).where(eq(eloverblikConnections.id, 1));
  routes.series = () => new Response('forbidden', { status: 403 });
  const at = new Date(NOW.getTime() + 20 * DAY);
  await assert.rejects(syncSelectedMeter(at), /METER_UNAUTHORIZED/);
  let row = await state();
  assert.equal(row.attention_code, 'METER_UNAUTHORIZED');
  assert.notEqual(row.refresh_token, null, 'a meter-level rejection is not treated as a revoked token');

  // Reselecting the same meter clears the pause and keeps its progress.
  routes = defaultRoutes();
  await selectMeter(FIXTURE_METER, 'household');
  row = await state();
  assert.equal(row.attention_code, null);
  assert.equal(row.last_success_at?.toISOString(), NOW.toISOString());

  routes.series = () => Response.json({ result: [] });
  await assert.rejects(syncSelectedMeter(new Date(at.getTime() + DAY)), /METER_MISSING/);
  assert.equal((await state()).attention_code, 'METER_MISSING');

  routes = defaultRoutes();
  routes.meters = () => Response.json(meterListEnvelope([{ id: FIXTURE_METER }, { id: OTHER_FIXTURE_METER }]));
  await selectMeter(OTHER_FIXTURE_METER, 'dedicated_lab');
  row = await state();
  assert.equal(row.last_success_at, null);
  assert.equal(row.latest_interval_end, null);
  assert.equal(row.import_cursor, null);
  calls.length = 0;
  routes.series = seriesWith(OTHER_FIXTURE_METER, '2026-10-07');
  await syncSelectedMeter(new Date(at.getTime() + 2 * DAY));
  const first = calls.find((call) => call.url.pathname.includes('gettimeseries'))!;
  assert.equal(seriesRange(first.url).from, new Date(Date.UTC(2026, 9, 30) - 395 * DAY).toISOString().slice(0, 10), 'full backfill for the new meter');

  // Disconnect keeps history unless a purge is explicitly requested.
  assert.deepEqual(await disconnect(), { purged: false });
  assert(await intervalCount() > 0);
  assert.deepEqual(await disconnect({ purgeHistory: true }), { purged: true });
  assert.equal(await intervalCount(), 0);
  assert.equal((await fixture.db.select().from(eloverblikChargeSnapshots)).length, 0);
});
