import test from 'node:test';
import assert from 'node:assert/strict';
import { ElOverblikClient } from './eloverblikClient.ts';

const meter = '571313180000000001';
test('one token exchange serves concurrent meter reads and uses official fixed origin', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith('/token')) return Response.json({ result: 'access-token' });
    return Response.json({ result: [{ meteringPointId: meter, hasRelation: true, typeOfMP: 'E17' }] });
  };
  const client = new ElOverblikClient({ fetcher: fetcher as typeof fetch, now: () => 0 });
  const [first, second] = await Promise.all([client.listMeters('refresh-token'), client.listMeters('refresh-token')]);
  assert.deepEqual(first, second);
  assert.equal(requests.filter(({ url }) => url.endsWith('/token')).length, 1);
  assert(requests.every(({ url, init }) => url.startsWith('https://api.eloverblik.dk/customerapi/api/') && init.redirect === 'error'));
});
test('rejects HTTP-success malformed meter response', async () => {
  const fetcher = async (url: string) => Response.json(url.endsWith('/token') ? { result: 'access-token' } : { result: { success: false, errorCode: 20010 } });
  const client = new ElOverblikClient({ fetcher: fetcher as typeof fetch });
  await assert.rejects(client.listMeters('refresh'), /MALFORMED/);
});

const { parseRetryAfter, MAX_RETRY_AFTER_MS } = await import('./eloverblikClient.ts');
const { fixtureAccessToken } = await import('../testUtils/eloverblikFixtures.ts');
type Route = (url: string, init: RequestInit) => Response;
function fakeClient(route: Route, clock = { now: 0 }) {
  const requests: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => { requests.push(url.replace('https://api.eloverblik.dk/customerapi/api', '')); return route(url, init); };
  return { client: new ElOverblikClient({ fetcher: fetcher as typeof fetch, now: () => clock.now }), requests, clock };
}
const ok = (expSeconds: number) => (url: string) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(expSeconds) })
  : Response.json({ result: [{ meteringPointId: meter, hasRelation: true, typeOfMP: 'E17' }] });

test('Retry-After accepts delay-seconds and HTTP-dates and is clamped to a day', () => {
  assert.equal(parseRetryAfter('120', 0), 120_000);
  assert.equal(parseRetryAfter('10800', 0), 3 * 3_600_000, 'multi-hour hints are honoured');
  assert.equal(parseRetryAfter(new Date(2 * 3_600_000).toUTCString(), 0), 2 * 3_600_000);
  assert.equal(parseRetryAfter(new Date(0).toUTCString(), 5000), 0, 'a past date means retry now');
  assert.equal(parseRetryAfter('999999999', 0), MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter('soon', 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
});
test('expired access tokens are refreshed once, single-flight, using the token exp claim', async () => {
  const { client, requests, clock } = fakeClient(ok(3600));
  await Promise.all([client.listMeters('r'), client.listMeters('r'), client.listMeters('r')]);
  assert.equal(requests.filter((path) => path === '/token').length, 1);
  clock.now = 3600_000 - 9 * 60_000; // inside the 10-minute safety margin before exp
  await client.listMeters('r');
  assert.equal(requests.filter((path) => path === '/token').length, 2);
});
test('rejected access token is refreshed and retried exactly once', async () => {
  let rejections = 1;
  const { client, requests } = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) })
    : rejections-- > 0 ? new Response(null, { status: 401 }) : Response.json({ result: [{ meteringPointId: meter, hasRelation: true }] }));
  assert.equal((await client.listMeters('r')).length, 1);
  assert.deepEqual(requests.map((path) => path.split('?')[0]), ['/token', '/meteringpoints/meteringpoints', '/token', '/meteringpoints/meteringpoints']);
});
test('revoked refresh token means reconnect; per-meter rejection does not', async () => {
  const revoked = fakeClient((url) => url.endsWith('/token') ? new Response(null, { status: 401 }) : Response.json({ result: [] }));
  await assert.rejects(revoked.client.listMeters('r'), /RECONNECT_REQUIRED/);
  const forbidden = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) }) : new Response(null, { status: 403 }));
  await assert.rejects(forbidden.client.timeSeries('r', meter, '2026-10-01', '2026-10-02'), /METER_UNAUTHORIZED/);
  assert.equal(forbidden.requests.filter((path) => path === '/token').length, 1, '403 is not an access-token expiry');
  const meter401 = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) }) : new Response(null, { status: 401 }));
  await assert.rejects(meter401.client.charges('r', meter), /METER_UNAUTHORIZED/, 'a fresh token rejected for one meter is a meter-level problem');
  const account401 = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) }) : new Response(null, { status: 401 }));
  await assert.rejects(account401.client.listMeters('r'), /RECONNECT_REQUIRED/);
});
test('429 and 503 carry the provider Retry-After; TLS/network failures are generic', async () => {
  const limited = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) })
    : new Response(null, { status: 429, headers: { 'Retry-After': '7200' } }));
  await assert.rejects(limited.client.listMeters('r'), (err: any) => err.code === 'RATE_LIMITED' && err.retryAfterMs === 7_200_000);
  const unavailable = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) })
    : new Response(null, { status: 503, headers: { 'Retry-After': new Date(60_000).toUTCString() } }));
  await assert.rejects(unavailable.client.listMeters('r'), (err: any) => err.code === 'HTTP_503' && err.retryAfterMs === 60_000);
  const tls = new ElOverblikClient({ fetcher: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }); }) as typeof fetch });
  await assert.rejects(tls.listMeters('r'), (err: any) => err.code === 'NETWORK' && !/LEAF|fetch failed/.test(err.message));
});
test('oversized bodies are rejected while streaming', async () => {
  const big = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) })
    : new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); } })));
  await assert.rejects(big.client.listMeters('r'), /OVERSIZED/);
});
test('numeric metering point IDs are rejected because they have lost precision', async () => {
  const { client } = fakeClient((url) => url.endsWith('/token') ? Response.json({ result: fixtureAccessToken(10 ** 9) })
    : new Response(`{"result":[{"meteringPointId":571313180000000003,"hasRelation":true},{"meteringPointId":"${meter}","hasRelation":true}]}`, { headers: { 'content-type': 'application/json' } }));
  assert.deepEqual((await client.listMeters('r')).map((item) => item.id), [meter]);
});
