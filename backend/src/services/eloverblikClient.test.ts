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
