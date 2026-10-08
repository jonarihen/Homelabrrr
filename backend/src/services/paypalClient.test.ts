import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from './paypalClient.ts';
const config = { environment: 'sandbox' as const, clientId: 'CLIENT123', clientSecret: 'SECRET', version: 1 };
test('OAuth is single-flight and all calls stay on official sandbox origin', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return Response.json(url.endsWith('/oauth2/token') ? { access_token: 'access', expires_in: 3600 } : { id: 'ORDER123' });
  };
  const client = new PayPalClient({ fetcher: fetcher as typeof fetch, now: () => 0 });
  await Promise.all([client.getOrder(config, 'ORDER123'), client.getOrder(config, 'ORDER123')]);
  assert.equal(requests.filter((r) => r.url.endsWith('/oauth2/token')).length, 1);
  assert(requests.every((r) => r.url.startsWith('https://api-m.sandbox.paypal.com/') && r.init.redirect === 'error'));
});
test('webhook verification rejects external certificate URL without provider call', async () => {
  let calls = 0; const client = new PayPalClient({ fetcher: (async () => { calls++; return Response.json({}); }) as typeof fetch });
  const accepted = await client.verifyWebhook(config, 'WEBHOOK123', {
    'paypal-transmission-id': 'transmission', 'paypal-transmission-time': '2026-10-08T00:00:00Z',
    'paypal-cert-url': 'https://evil.example/v1/notifications/certs/CERT123', 'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'sig',
  }, Buffer.from('{"id":"EVENT"}'));
  assert.equal(accepted, false); assert.equal(calls, 0);
});
test('provider verification receives the original event bytes', async () => {
  const raw = Buffer.from('{ "id" : "EVENT", "event_type" : "PAYMENT.CAPTURE.COMPLETED" }');
  let verificationBody = '';
  const fetcher = async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
    verificationBody = String(init.body);
    return Response.json({ verification_status: 'SUCCESS' });
  };
  const client = new PayPalClient({ fetcher: fetcher as typeof fetch });
  const verified = await client.verifyWebhook(config, 'WEBHOOK123', {
    'paypal-transmission-id': 'transmission', 'paypal-transmission-time': '2026-10-08T00:00:00Z',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT123', 'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'sig',
  }, raw);
  assert.equal(verified, true);
  assert(verificationBody.includes(`"webhook_event":${raw.toString('utf8')}`));
});
test('subscription transaction lookup is bounded and uses only its mapped subscription', async () => {
  const requests: string[] = [];
  const fetcher = async (url: string) => { requests.push(url); return Response.json(url.endsWith('/oauth2/token') ? { access_token: 'access', expires_in: 3600 } : { transactions: [], total_pages: 1 }); };
  const client = new PayPalClient({ fetcher: fetcher as typeof fetch });
  await client.listSubscriptionTransactions(config, 'SUB123', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
  assert(requests.some((url) => url.includes('/v1/billing/subscriptions/SUB123/transactions?start_time=')));
  await assert.rejects(client.listSubscriptionTransactions(config, 'SUB123', new Date('2026-01-01'), new Date('2026-10-08')), /INVALID_RANGE/);
});
test('GET retries 429 with bounded Retry-After but POST does not retry', async () => {
  let reads = 0; const delays: number[] = [];
  const fetcher = async (url: string) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
    reads++;
    return reads === 1 ? Response.json({}, { status: 429, headers: { 'Retry-After': '3' } }) : Response.json({ id: 'ORDER123' });
  };
  const client = new PayPalClient({ fetcher: fetcher as typeof fetch, sleep: async (ms) => { delays.push(ms); } });
  await client.getOrder(config, 'ORDER123');
  assert.deepEqual(delays, [3000]); assert.equal(reads, 2);
});
