import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { paypalIntents, paypalPostings, paypalSubscriptions, paypalTransactions, paypalWebhookInbox, users } from '../db/schema/index.ts';

process.env.SECRET_ENCRYPTION_KEY = '75'.repeat(32);
process.env.ALLOWED_ORIGIN = 'https://portal.example';
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());

const calls: Array<{ path: string; method: string; body: any }> = [];
let webhookValid = true;
let cancellationConfirmed = false;
let createdIntent = '';
let createdSubscriptionIntent = '';
let orderCompleted = false;
const capture = { id: 'CAPTURE123', status: 'COMPLETED', payee: { merchant_id: 'MERCHANT123' },
  supplementary_data: { related_ids: { order_id: 'ORDER123' } }, amount: { currency_code: 'DKK', value: '100.00' },
  seller_receivable_breakdown: { gross_amount: { currency_code: 'DKK', value: '100.00' },
    paypal_fee: { currency_code: 'DKK', value: '4.00' }, net_amount: { currency_code: 'DKK', value: '96.00' } },
  create_time: '2026-10-08T12:00:00Z' };
const refund = { id: 'REFUND123', status: 'COMPLETED', amount: { currency_code: 'DKK', value: '20.00' },
  seller_payable_breakdown: { gross_amount: { currency_code: 'DKK', value: '20.00' },
    paypal_fee: { currency_code: 'DKK', value: '0.50' }, net_amount: { currency_code: 'DKK', value: '19.50' } },
  links: [{ rel: 'up', method: 'GET', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123' }],
  create_time: '2026-10-08T13:00:00Z' };

globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
  const parsed = new URL(String(url));
  assert.equal(parsed.origin, 'https://api-m.sandbox.paypal.com');
  const method = init.method || 'GET';
  const body = init.body && String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : null;
  calls.push({ path: parsed.pathname, method, body });
  if (parsed.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
  if (parsed.pathname === '/v2/checkout/orders' && method === 'POST') {
    createdIntent = body.purchase_units[0].custom_id;
    assert.equal(body.payment_source.paypal.experience_context.return_url, 'https://portal.example/support?paypal=one-off');
    return Response.json({ id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123' }] });
  }
  if (parsed.pathname === '/v2/checkout/orders/ORDER123' && method === 'GET') return Response.json({ id: 'ORDER123', status: orderCompleted ? 'COMPLETED' : 'APPROVED',
    purchase_units: [{ custom_id: createdIntent, payee: { merchant_id: 'MERCHANT123' }, amount: { currency_code: 'DKK', value: '100.00' },
      ...(orderCompleted ? { payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED' }] } } : {}) }] });
  if (parsed.pathname === '/v2/checkout/orders/ORDER123/capture') return Response.json({ purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED' }] } }] });
  if (parsed.pathname === '/v2/payments/captures/CAPTURE123') return Response.json(capture);
  if (parsed.pathname === '/v2/payments/refunds/REFUND123') return Response.json(refund);
  if (parsed.pathname === '/v1/notifications/verify-webhook-signature') return Response.json({ verification_status: webhookValid ? 'SUCCESS' : 'FAILURE' });
  if (parsed.pathname === '/v1/billing/plans/PLAN12345') return Response.json({ status: 'ACTIVE', billing_cycles: [{ tenure_type: 'REGULAR', frequency: { interval_unit: 'MONTH', interval_count: 1 },
    pricing_scheme: { fixed_price: { currency_code: 'DKK', value: '50.00' } } }], payment_preferences: { auto_bill_outstanding: false } });
  if (parsed.pathname === '/v1/billing/subscriptions' && method === 'POST') {
    createdSubscriptionIntent = body.custom_id;
    assert.equal(body.application_context.return_url, 'https://portal.example/support?paypal=monthly');
    return Response.json({ id: 'SUB123', status: 'APPROVAL_PENDING', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=SUB123' }] });
  }
  if (parsed.pathname === '/v1/billing/subscriptions/SUB123' && method === 'GET') return Response.json({ id: 'SUB123', plan_id: 'PLAN12345', custom_id: createdSubscriptionIntent,
    status: cancellationConfirmed ? 'CANCELLED' : 'ACTIVE', status_update_time: '2026-10-08T14:00:00Z' });
  if (parsed.pathname === '/v1/billing/subscriptions/SUB123/transactions') return Response.json({ total_pages: 1, transactions: [
    { id: 'SALE123', status: 'COMPLETED', time: '2026-10-08T14:00:00Z', amount_with_breakdown: {
      gross_amount: { currency_code: 'DKK', value: '50.00' }, fee_amount: { currency_code: 'DKK', value: '2.00' },
      net_amount: { currency_code: 'DKK', value: '48.00' } } },
  ] });
  if (parsed.pathname === '/v1/billing/subscriptions/SUB123/cancel') { cancellationConfirmed = true; return new Response(null, { status: 204 }); }
  throw new Error(`Unexpected PayPal fixture request: ${method} ${parsed.pathname}`);
}) as typeof fetch;

const { default: paymentRoutes } = await import('./payments.ts');
const { default: webhookRoutes } = await import('./paymentsWebhook.ts');
const { processPaypalInbox, pruneProcessedPaypalWebhookEvidence, reconcileSubscription, savePaypalConfiguration, setPaypalEnabled, verifiedContributionSnapshot } = await import('../services/paypal.ts');
const { postReceipt } = await import('../services/paypalLedger.ts');
const { waitForBackgroundWork } = await import('../services/backgroundWork.ts');
const app = express();
app.set('trust proxy', true);
app.use('/api/payments/paypal/webhook', webhookRoutes);
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.get('x-test-role');
  if (role) req.session = { userId: role === 'other' ? 2 : 1, username: role, isAdmin: role === 'admin',
    reauthenticatedAt: req.get('x-test-reauth') === 'yes' ? Date.now() : undefined } as typeof req.session;
  if (req.get('x-test-api-token') === 'yes') req.apiToken = {} as typeof req.apiToken;
  next();
});
app.use('/api/payments', paymentRoutes);
const path = '/api/payments';
const as = (role: string) => ({ 'x-test-role': role });

test('sandbox provider fixture: authorization, capture, webhook replay, refund and cancellation', async () => {
  await fixture.db.insert(users).values([
    { id: 1, username: 'member-fixture', password: 'unused' },
    { id: 2, username: 'other-fixture', password: 'unused' },
  ]);
  assert.equal((await request(app).get(`${path}/mine`)).status, 401);
  assert.equal((await request(app).get(`${path}/admin/config`).set(as('member'))).status, 403);
  assert.equal((await request(app).post(`${path}/admin/config`).set(as('admin')).send({})).body.code, 'REAUTHENTICATION_REQUIRED');
  assert.equal((await request(app).post(`${path}/admin/config`).set(as('admin')).set('x-test-api-token', 'yes').send({})).status, 403);

  await savePaypalConfiguration({ environment: 'sandbox', clientId: 'CLIENT123', clientSecret: 'FIXTURESECRET', merchantId: 'MERCHANT123', webhookId: 'WEBHOOK123' });
  assert.equal((await request(app).post(`${path}/one-off`).set(as('member')).send({ amount: '100.00', environment: 'sandbox' })).body.error, 'CHECKOUT_DISABLED');
  await setPaypalEnabled('sandbox', true);
  const checkout = await request(app).post(`${path}/one-off`).set(as('member')).send({ amount: '100.00', environment: 'sandbox' });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.status, 'approval_pending');
  assert.equal((await fixture.db.select().from(paypalPostings)).length, 0);
  assert.equal((await request(app).post(`${path}/one-off/${checkout.body.intentId}/capture`).set(as('other'))).status, 404);
  const captured = await request(app).post(`${path}/one-off/${checkout.body.intentId}/capture`).set(as('member'));
  assert.equal(captured.status, 200);
  assert.equal(captured.body.status, 'verified');
  assert.equal((await request(app).post(`${path}/one-off/${checkout.body.intentId}/capture`).set(as('member'))).body.status, 'verified');
  await fixture.db.update(paypalIntents).set({ status: 'capture_unknown' }).where(eq(paypalIntents.id, checkout.body.intentId));
  const capturePosts = calls.filter((call) => call.path === '/v2/checkout/orders/ORDER123/capture').length;
  assert.equal((await request(app).post(`${path}/one-off/${checkout.body.intentId}/capture`).set(as('member'))).body.status, 'pending_verification');
  assert.equal(calls.filter((call) => call.path === '/v2/checkout/orders/ORDER123/capture').length, capturePosts,
    'retry while provider outcome is unknown must not issue another capture');
  orderCompleted = true;
  assert.equal((await request(app).post(`${path}/one-off/${checkout.body.intentId}/capture`).set(as('member'))).body.status, 'verified');
  assert.equal(calls.filter((call) => call.path === '/v2/checkout/orders/ORDER123/capture').length, capturePosts,
    'completed order readback must reuse the existing economic posting');

  const webhookEvent = { id: 'EVENT123', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-10-08T12:01:00Z',
    resource: { id: 'CAPTURE123', payee: { merchant_id: 'MERCHANT123' }, supplementary_data: { related_ids: { order_id: 'ORDER123' } } } };
  const webhook = () => request(app).post(`${path}/paypal/webhook/sandbox`).set('x-forwarded-proto', 'https').set('content-type', 'application/json')
    .set('paypal-transmission-id', 'TRANSMISSION123').set('paypal-transmission-time', '2026-10-08T12:01:00Z')
    .set('paypal-cert-url', 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT123')
    .set('paypal-auth-algo', 'SHA256withRSA').set('paypal-transmission-sig', 'fixture-signature');
  assert.equal((await webhook().send(JSON.stringify(webhookEvent))).status, 204);
  assert.equal((await webhook().send(JSON.stringify(webhookEvent))).status, 204);
  await waitForBackgroundWork();
  await processPaypalInbox(); await processPaypalInbox();
  assert.equal((await fixture.db.select().from(paypalWebhookInbox)).length, 1);
  assert.deepEqual((await fixture.db.select().from(paypalPostings)).map((row) => row.amount_ore).sort((a, b) => a - b), [-400, 10000]);
  webhookValid = false;
  assert.equal((await webhook().send(JSON.stringify({ ...webhookEvent, id: 'INVALID123' }))).status, 401);
  assert.equal((await request(app).post(`${path}/paypal/webhook/sandbox`).set('content-type', 'application/json').send(webhookEvent)).status, 403);
  assert.equal((await fixture.db.select().from(paypalWebhookInbox)).length, 1);
  webhookValid = true;

  const refundEvent = { id: 'EVENTREFUND123', event_type: 'PAYMENT.CAPTURE.REFUNDED', create_time: '2026-10-08T13:00:00Z', resource: { id: 'REFUND123' } };
  assert.equal((await webhook().send(JSON.stringify(refundEvent))).status, 204);
  await waitForBackgroundWork();
  await processPaypalInbox(); await processPaypalInbox();
  assert.deepEqual((await fixture.db.select().from(paypalWebhookInbox)).map((row) => [row.id, row.status, row.error_code]), [
    ['sandbox:MERCHANT123:EVENT123', 'processed', null], ['sandbox:MERCHANT123:EVENTREFUND123', 'processed', null],
  ]);
  assert.deepEqual((await fixture.db.select().from(paypalPostings)).map((row) => row.amount_ore).sort((a, b) => a - b), [-2000, -400, 50, 10000]);
  assert.equal((await fixture.db.select().from(paypalTransactions)).length, 2);
  const otherHistory = await request(app).get(`${path}/mine`).set(as('other'));
  assert.equal(otherHistory.status, 200); assert.equal(otherHistory.body.postings.length, 0);
  const ownHistory = await request(app).get(`${path}/mine`).set(as('member'));
  assert.equal(ownHistory.body.postings.length, 4);

  await savePaypalConfiguration({ environment: 'sandbox', clientId: 'CLIENT123', clientSecret: 'FIXTURESECRET', merchantId: 'MERCHANT123', webhookId: 'WEBHOOK123',
    monthlyPlanId: 'PLAN12345', monthlyAmount: '50.00' });
  await setPaypalEnabled('sandbox', true);
  const monthly = await request(app).post(`${path}/monthly`).set(as('member')).send({ environment: 'sandbox' });
  assert.equal(monthly.status, 201);
  assert.equal((await fixture.db.select().from(paypalPostings)).length, 4, 'approval alone is not a monthly receipt');
  const [subBefore] = await fixture.db.select().from(paypalSubscriptions).where(eq(paypalSubscriptions.id, 'SUB123'));
  await reconcileSubscription(subBefore, new Date('2026-10-07T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
  await reconcileSubscription(subBefore, new Date('2026-10-07T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
  assert.deepEqual((await fixture.db.select().from(paypalPostings)).map((row) => row.amount_ore).sort((a, b) => a - b),
    [-2000, -400, -200, 50, 5000, 10000]);
  assert.equal((await request(app).post(`${path}/monthly/SUB123/cancel`).set(as('other'))).status, 404);
  assert.equal((await request(app).post(`${path}/monthly/SUB123/cancel`).set(as('member'))).body.status, 'cancelled');
  const [subscription] = await fixture.db.select().from(paypalSubscriptions).where(eq(paypalSubscriptions.id, 'SUB123'));
  assert.equal(subscription.status, 'CANCELLED');
  assert.equal(calls.filter((call) => call.path === '/v1/billing/subscriptions/SUB123/cancel').length, 1);
  assert.equal((await fixture.db.select().from(paypalIntents)).length, 2);

  const unknown = { transactionId: 'UNKNOWNFEE123', grossOre: 1000, feeOre: null, netOre: null,
    effectiveAt: new Date('2026-10-08T15:00:00Z') };
  assert.equal((await postReceipt({ environment: 'sandbox', merchantId: 'MERCHANT123', intentId: checkout.body.intentId, userId: 1 },
    'capture', unknown, 'fixture')).status, 'net_unresolved');
  assert.equal((await fixture.db.select().from(paypalPostings)).length, 6, 'unknown fee must not enter the net ledger');
  assert.equal((await verifiedContributionSnapshot('sandbox')).eligibleNetOre, null);
  assert.equal((await postReceipt({ environment: 'sandbox', merchantId: 'MERCHANT123', intentId: checkout.body.intentId, userId: 1 },
    'capture', { ...unknown, feeOre: 40, netOre: 960 }, 'fixture')).status, 'posted');
  assert.equal((await fixture.db.select().from(paypalPostings)).length, 8);
  assert.equal((await verifiedContributionSnapshot('sandbox')).eligibleNetOre, 13_410);

  await fixture.db.update(paypalWebhookInbox).set({ processed_at: new Date('2026-08-01T00:00:00Z') })
    .where(eq(paypalWebhookInbox.status, 'processed'));
  await fixture.db.insert(paypalWebhookInbox).values({ id: 'sandbox:MERCHANT123:REVIEW123', environment: 'sandbox',
    merchant_id: 'MERCHANT123', event_type: 'PAYMENT.CAPTURE.COMPLETED', payload: { review: 'retain evidence' },
    status: 'needs_review', processed_at: new Date('2026-08-01T00:00:00Z') });
  const beforePrune = (await fixture.db.select().from(paypalWebhookInbox)).length;
  assert.equal(await pruneProcessedPaypalWebhookEvidence(new Date('2026-10-08T00:00:00Z')), beforePrune - 1);
  const pruned = await fixture.db.select().from(paypalWebhookInbox);
  assert(pruned.filter((event) => event.status === 'processed').every((event) =>
    Object.keys(event.payload as object).length === 0), 'processed raw provider payloads are discarded');
  assert.deepEqual(pruned.find((event) => event.status === 'needs_review')?.payload, { review: 'retain evidence' });
  assert.equal((await webhook().send(JSON.stringify(webhookEvent))).status, 204);
  assert.equal((await fixture.db.select().from(paypalWebhookInbox)).length, beforePrune,
    'dedupe IDs survive payload pruning');
  assert.equal(await pruneProcessedPaypalWebhookEvidence(new Date('2026-10-08T00:00:00Z')), 0);
});
