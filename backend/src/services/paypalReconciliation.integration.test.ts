import test from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { paypalIntents, paypalPostings, paypalReconciliation, paypalSubscriptions, paypalTransactions, users } from '../db/schema/index.ts';

// Fixture-only PayPal transport: every request is answered from in-memory
// routes and nothing ever reaches PayPal.
process.env.SECRET_ENCRYPTION_KEY = '76'.repeat(32);
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());

type Call = { method: string; path: string; requestId: string | null };
const calls: Call[] = [];
let routes: Record<string, (url: URL, body: any) => any> = {};
globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
  const parsed = new URL(String(url));
  assert.equal(parsed.origin, 'https://api-m.sandbox.paypal.com');
  const method = init.method || 'GET';
  const headers = (init.headers || {}) as Record<string, string>;
  calls.push({ method, path: parsed.pathname, requestId: headers['PayPal-Request-Id'] ?? null });
  if (parsed.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
  const handler = routes[`${method} ${parsed.pathname}`];
  if (!handler) return Response.json({ name: 'RESOURCE_NOT_FOUND' }, { status: 404 });
  const result = handler(parsed, init.body ? JSON.parse(String(init.body)) : null);
  if (result instanceof Response) return result;
  return Response.json(result);
}) as typeof fetch;

const paypal = await import('./paypal.ts');
const { paypalClient } = await import('./paypalClient.ts');
const { settleSaleAdjustments, adjustmentCoverageComplete } = await import('./paypalCoverage.ts');
const { PayPalError } = await import('./paypalClient.ts');

const MERCHANT = 'MERCHANT123';
const dkk = (value: string) => ({ currency_code: 'DKK', value });
const config = { environment: 'sandbox' as const, clientId: 'CLIENT123', clientSecret: 'FIXTURESECRET', version: 0 };
let intentCounter = 0;

async function seedIntent(overrides: Partial<typeof paypalIntents.$inferInsert> = {}) {
  intentCounter++;
  const id = `intent-${intentCounter}`;
  const [row] = await fixture.db.insert(paypalIntents).values({ id, user_id: 1, environment: 'sandbox', merchant_id: MERCHANT, kind: 'one_off',
    amount_ore: 10000, status: 'approval_pending', provider_id: `ORDER${intentCounter}`, create_request_id: `create-${intentCounter}`,
    config_version: 1, ...overrides }).returning();
  return row;
}
function order(intent: typeof paypalIntents.$inferSelect, payments: any = undefined, status = 'COMPLETED') {
  return { id: intent.provider_id, status, purchase_units: [{ custom_id: intent.id, payee: { merchant_id: MERCHANT },
    amount: dkk('100.00'), ...(payments ? { payments } : {}) }] };
}
function captureDetail(intent: typeof paypalIntents.$inferSelect, id: string, status: string, breakdown = true) {
  return { id, status, payee: { merchant_id: MERCHANT }, supplementary_data: { related_ids: { order_id: intent.provider_id } },
    amount: dkk('100.00'), create_time: '2026-10-08T12:00:00Z',
    seller_receivable_breakdown: breakdown ? { gross_amount: dkk('100.00'), paypal_fee: dkk('4.00'), net_amount: dkk('96.00') }
      : { gross_amount: dkk('100.00') } };
}
function refundDetail(id: string, captureId: string, value: string, fee: string, total?: string) {
  const net = ((Number(value) * 100 - Number(fee) * 100) / 100).toFixed(2);
  return { id, status: 'COMPLETED', amount: dkk(value), create_time: '2026-10-09T12:00:00Z',
    seller_payable_breakdown: { gross_amount: dkk(value), paypal_fee: dkk(fee), net_amount: dkk(net),
      ...(total ? { total_refunded_amount: dkk(total) } : {}) },
    links: [{ rel: 'up', method: 'GET', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}` }] };
}
async function postingsFor(intentId: string) {
  return (await fixture.db.select().from(paypalPostings).where(eq(paypalPostings.intent_id, intentId)))
    .map((row) => `${row.posting_kind}:${row.amount_ore}`).sort();
}
async function placeholder(originalId: string) {
  const [row] = await fixture.db.select().from(paypalTransactions).where(eq(paypalTransactions.provider_transaction_id, `adjustment:${originalId}`));
  return row;
}

test.before(async () => {
  await fixture.db.insert(users).values({ id: 1, username: 'member-fixture', password: 'unused' });
  await paypal.savePaypalConfiguration({ environment: 'sandbox', clientId: 'CLIENT123', clientSecret: 'FIXTURESECRET', merchantId: MERCHANT, webhookId: 'WEBHOOK123' });
  const [row] = await fixture.db.select().from(paypalReconciliation);
  assert.equal(row, undefined);
  config.version = (await paypal.paypalSetupStatus())[0].configVersion;
});
test.beforeEach(() => { routes = {}; calls.length = 0; paypalClient.invalidate(); });

test('coverage rule: full refunds need exact coverage; partial refunds need complete evidence', () => {
  assert.equal(adjustmentCoverageComplete({ status: 'REFUNDED', grossOre: 100, coveredOre: 100, listingComplete: false }), true);
  assert.equal(adjustmentCoverageComplete({ status: 'REFUNDED', grossOre: 100, coveredOre: 60, listingComplete: true }), false);
  assert.equal(adjustmentCoverageComplete({ status: 'PARTIALLY_REFUNDED', grossOre: 100, coveredOre: 0, listingComplete: true }), false);
  assert.equal(adjustmentCoverageComplete({ status: 'PARTIALLY_REFUNDED', grossOre: 100, coveredOre: 20, listingComplete: true }), true);
  assert.equal(adjustmentCoverageComplete({ status: 'PARTIALLY_REFUNDED', grossOre: 100, coveredOre: 20, listingComplete: true, providerTotalOre: 30 }), false);
  assert.equal(adjustmentCoverageComplete({ status: 'PARTIALLY_REFUNDED', grossOre: 100, coveredOre: 20, listingComplete: false }), false);
  assert.equal(adjustmentCoverageComplete({ status: 'PARTIALLY_REFUNDED', grossOre: 100, coveredOre: 20, listingComplete: false, eventsCoveredSinceObservation: true }), true);
  assert.equal(adjustmentCoverageComplete({ status: 'REVERSED', grossOre: 100, coveredOre: 120, listingComplete: true }), false);
});

test('gap 1: a partially refunded capture with a lost refund webhook records the refund from order readback', async () => {
  const intent = await seedIntent({ status: 'capture_unknown', capture_request_id: 'capture-req-1' });
  routes[`GET /v2/checkout/orders/${intent.provider_id}`] = () => order(intent, {
    captures: [{ id: 'CAPA', status: 'PARTIALLY_REFUNDED' }], refunds: [{ id: 'REFA', status: 'COMPLETED' }] });
  routes['GET /v2/payments/captures/CAPA'] = () => captureDetail(intent, 'CAPA', 'PARTIALLY_REFUNDED');
  routes['GET /v2/payments/refunds/REFA'] = () => refundDetail('REFA', 'CAPA', '20.00', '0.50', '20.00');
  const result = await paypal.reconcileUncertainCapture(config, intent);
  assert.equal(result.status, 'verified');
  assert.deepEqual(await postingsFor(intent.id), ['fee:-400', 'fee_credit:50', 'gross:10000', 'refund:-2000']);
  assert.equal((await placeholder('CAPA')).status, 'resolved');
  assert.equal(calls.filter((call) => call.path.endsWith('/capture')).length, 0, 'readback found the capture; no new capture');
});

test('gap 1: a refunded capture whose refunds are not yet visible stays unresolved and blocks eligible net', async () => {
  const intent = await seedIntent({ status: 'capture_unknown', capture_request_id: 'capture-req-2' });
  let refunds: any[] = [{ id: 'REFB', status: 'PENDING' }];
  routes[`GET /v2/checkout/orders/${intent.provider_id}`] = () => order(intent, { captures: [{ id: 'CAPB', status: 'REFUNDED' }], refunds });
  routes['GET /v2/payments/captures/CAPB'] = () => captureDetail(intent, 'CAPB', 'REFUNDED');
  routes['GET /v2/payments/refunds/REFB'] = () => refundDetail('REFB', 'CAPB', '100.00', '0.00', '100.00');
  assert.equal((await paypal.reconcileUncertainCapture(config, intent)).status, 'net_unresolved');
  assert.deepEqual(await postingsFor(intent.id), ['fee:-400', 'gross:10000'], 'the gross was received but is not finalized');
  assert.equal((await placeholder('CAPB')).status, 'net_unresolved');
  const snapshot = await paypal.verifiedContributionSnapshot('sandbox');
  assert.equal(snapshot.eligibleNetOre, null, 'a refunded capture must never finalize as income');

  // The refund completes; the next reconciliation enrichment pass resolves it.
  refunds = [{ id: 'REFB', status: 'COMPLETED' }];
  const pass = await paypal.reconcilePaypal('sandbox', new Date());
  assert.ok(['ok', 'partial'].includes(pass.status as string));
  assert.deepEqual(await postingsFor(intent.id), ['fee:-400', 'fee_credit:0', 'gross:10000', 'refund:-10000']);
  assert.equal((await placeholder('CAPB')).status, 'resolved');
  const [after] = await fixture.db.select().from(paypalIntents).where(eq(paypalIntents.id, intent.id));
  assert.equal(after.status, 'verified');
});

test('gap 2: a partially refunded subscription sale resolves once the refund is recorded and event recovery has caught up', async () => {
  const intent = await seedIntent({ kind: 'monthly', amount_ore: 5000, status: 'approval_pending', provider_id: 'SUBP' });
  const scope = { environment: 'sandbox', merchantId: MERCHANT, intentId: intent.id, userId: 1 };
  const { postReceipt, postProviderAdjustment } = await import('./paypalLedger.ts');
  await postReceipt(scope, 'sale', { transactionId: 'SALEP', grossOre: 5000, feeOre: 200, netOre: 4800, effectiveAt: new Date('2026-10-01T00:00:00Z') }, 'fixture');
  assert.equal((await settleSaleAdjustments(scope, 'SALEP', 'PARTIALLY_REFUNDED', 5000, new Date('2026-10-01T00:00:00Z'))).status, 'unresolved');
  await postProviderAdjustment(scope, 'SALEP', 'sale', 'refund', { transactionId: 'SALEPREF', grossOre: 1000, feeCreditOre: 0, netDebitOre: 1000,
    effectiveAt: new Date('2026-10-02T00:00:00Z') }, 'fixture');
  assert.equal((await settleSaleAdjustments(scope, 'SALEP', 'PARTIALLY_REFUNDED', 5000, null)).status, 'unresolved',
    'missed-event recovery has not yet covered the observation time');
  await fixture.db.insert(paypalReconciliation).values({ environment: 'sandbox', cursor_at: new Date(Date.now() + 60_000) })
    .onConflictDoUpdate({ target: paypalReconciliation.environment, set: { cursor_at: new Date(Date.now() + 60_000) } });
  assert.equal((await settleSaleAdjustments(scope, 'SALEP', 'PARTIALLY_REFUNDED', 5000, null)).status, 'resolved');
  // A later full refund reopens the placeholder until the remainder is recorded.
  assert.equal((await settleSaleAdjustments(scope, 'SALEP', 'REFUNDED', 5000, null)).status, 'unresolved');
  await postProviderAdjustment(scope, 'SALEP', 'sale', 'refund', { transactionId: 'SALEPREF2', grossOre: 4000, feeCreditOre: 0, netDebitOre: 4000,
    effectiveAt: new Date('2026-10-03T00:00:00Z') }, 'fixture');
  assert.equal((await settleSaleAdjustments(scope, 'SALEP', null, 5000, null)).status, 'resolved');
});

test('gap 3: one failing subscription neither aborts the pass nor stalls the event cursor', async () => {
  for (const [id, intentId] of [['SUBBAD', 'sub-intent-bad'], ['SUBGOOD', 'sub-intent-good']]) {
    await fixture.db.insert(paypalIntents).values({ id: intentId, user_id: 1, environment: 'sandbox', merchant_id: MERCHANT, kind: 'monthly',
      amount_ore: 5000, status: 'approval_pending', provider_id: id, create_request_id: `create-${id}`, config_version: 1 });
    await fixture.db.insert(paypalSubscriptions).values({ id, intent_id: intentId, user_id: 1, environment: 'sandbox', merchant_id: MERCHANT,
      status: 'ACTIVE', plan_id: 'PLAN12345', amount_ore: 5000 });
  }
  routes['GET /v1/notifications/webhooks-events'] = () => ({ events: [] });
  routes['GET /v1/billing/subscriptions/SUBBAD'] = () => ({ id: 'SUBBAD', plan_id: 'OTHERPLAN', custom_id: 'sub-intent-bad', status: 'ACTIVE' });
  routes['GET /v1/billing/subscriptions/SUBGOOD'] = () => ({ id: 'SUBGOOD', plan_id: 'PLAN12345', custom_id: 'sub-intent-good', status: 'ACTIVE' });
  routes['GET /v1/billing/subscriptions/SUBGOOD/transactions'] = () => ({ total_pages: 1, transactions: [
    { id: 'SALEGOOD', status: 'COMPLETED', time: new Date(Date.now() - 86_400_000).toISOString(),
      amount_with_breakdown: { gross_amount: dkk('50.00'), fee_amount: dkk('2.00'), net_amount: dkk('48.00') } }] });
  const now = new Date();
  const result = await paypal.reconcilePaypal('sandbox', now);
  assert.equal(result.status, 'partial');
  const [health] = await fixture.db.select().from(paypalReconciliation);
  assert.ok(health.cursor_at && health.cursor_at > new Date(now.getTime() - 86_400_000), 'event cursor advanced despite the failure');
  assert.equal(health.status, 'partial');
  assert.ok(health.failed_items >= 1);
  const [bad] = await fixture.db.select().from(paypalSubscriptions).where(eq(paypalSubscriptions.id, 'SUBBAD'));
  assert.equal(bad.reconcile_failures, 1);
  assert.equal(bad.reconcile_error_code, 'SUBSCRIPTION_MISMATCH');
  assert.ok(bad.reconcile_next_at && bad.reconcile_next_at > now);
  assert.deepEqual(await postingsFor('sub-intent-good'), ['fee:-200', 'gross:5000'], 'the healthy subscription was still reconciled');
  calls.length = 0;
  await paypal.reconcilePaypal('sandbox', new Date(now.getTime() + 60_000));
  assert.equal(calls.filter((call) => call.path === '/v1/billing/subscriptions/SUBBAD').length, 0, 'backoff skips the failing mapping');
});

test('gap 5: a crash-orphaned capturing intent is captured again with its persisted request id', async () => {
  const intent = await seedIntent({ status: 'capturing', capture_request_id: 'persisted-capture-id', updated_at: new Date(Date.now() - 3_600_000) });
  let captured = false;
  routes[`GET /v2/checkout/orders/${intent.provider_id}`] = () => captured ?
    order(intent, { captures: [{ id: 'CAPR', status: 'COMPLETED' }] }) : order(intent, undefined, 'APPROVED');
  routes[`POST /v2/checkout/orders/${intent.provider_id}/capture`] = () => { captured = true;
    return { purchase_units: [{ payments: { captures: [{ id: 'CAPR', status: 'COMPLETED' }] } }] }; };
  routes['GET /v2/payments/captures/CAPR'] = () => captureDetail(intent, 'CAPR', 'COMPLETED');
  routes['GET /v1/notifications/webhooks-events'] = () => ({ events: [] });
  await paypal.reconcilePaypal('sandbox', new Date());
  const captureCalls = calls.filter((call) => call.path.endsWith('/capture'));
  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].requestId, 'persisted-capture-id');
  const [after] = await fixture.db.select().from(paypalIntents).where(eq(paypalIntents.id, intent.id));
  assert.equal(after.status, 'verified');
  assert.equal(after.capture_attempts, 1);
  await paypal.reconcilePaypal('sandbox', new Date());
  assert.equal(calls.filter((call) => call.path.endsWith('/capture')).length, 1, 'verified intents are never captured again');
  assert.deepEqual(await postingsFor(intent.id), ['fee:-400', 'gross:10000']);
});

test('gap 5: a fresh capturing intent is left alone and a capture failure leaves capture_unknown for retry', async () => {
  const fresh = await seedIntent({ status: 'capturing', capture_request_id: 'fresh-id' });
  const stuck = await seedIntent({ status: 'capture_unknown', capture_request_id: 'stuck-id' });
  routes[`GET /v2/checkout/orders/${stuck.provider_id}`] = () => order(stuck, undefined, 'APPROVED');
  routes[`POST /v2/checkout/orders/${stuck.provider_id}/capture`] = () => new Response('{}', { status: 503 });
  await assert.rejects(paypal.reconcileUncertainCapture(config, stuck), (err: unknown) => err instanceof PayPalError && err.code === 'HTTP_503');
  const [afterStuck] = await fixture.db.select().from(paypalIntents).where(eq(paypalIntents.id, stuck.id));
  assert.equal(afterStuck.status, 'capture_unknown');
  assert.equal(afterStuck.capture_attempts, 1);
  routes['GET /v1/notifications/webhooks-events'] = () => ({ events: [] });
  calls.length = 0;
  await paypal.reconcilePaypal('sandbox', new Date());
  assert.equal(calls.filter((call) => call.path.includes(String(fresh.provider_id))).length, 0, 'an in-flight member capture is not raced');
  await fixture.db.update(paypalIntents).set({ status: 'expired' }).where(eq(paypalIntents.id, stuck.id));
});

test('gap 5: missing fee detail is enriched from the provider without estimating', async () => {
  const intent = await seedIntent({ status: 'capture_unknown', capture_request_id: 'fee-id' });
  let feeKnown = false;
  routes[`GET /v2/checkout/orders/${intent.provider_id}`] = () => order(intent, { captures: [{ id: 'CAPF', status: 'COMPLETED' }] });
  routes['GET /v2/payments/captures/CAPF'] = () => captureDetail(intent, 'CAPF', 'COMPLETED', feeKnown);
  assert.equal((await paypal.reconcileUncertainCapture(config, intent)).status, 'net_unresolved');
  assert.deepEqual(await postingsFor(intent.id), []);
  const [row] = await fixture.db.select().from(paypalTransactions).where(and(eq(paypalTransactions.provider_transaction_id, 'CAPF')));
  feeKnown = true;
  await paypal.enrichUnresolvedTransaction(config, row);
  assert.deepEqual(await postingsFor(intent.id), ['fee:-400', 'gross:10000']);
});

test('gap 4: quarantined events can be retried or dismissed, and dismissal unblocks finalized net', async () => {
  const { paypalWebhookInbox } = await import('../db/schema/index.ts');
  const review = await import('./paypalReview.ts');
  await fixture.db.update(paypalTransactions).set({ status: 'resolved' }).where(eq(paypalTransactions.status, 'net_unresolved'));
  const postingsBefore = (await fixture.db.select().from(paypalPostings)).length;
  await fixture.db.insert(paypalWebhookInbox).values([
    { id: 'sandbox:MERCHANT123:WHREVIEW1', environment: 'sandbox', merchant_id: MERCHANT, event_type: 'PAYMENT.CAPTURE.COMPLETED',
      payload: { id: 'WHREVIEW1', resource: { id: 'UNRELATED' } }, status: 'needs_review', error_code: 'UNLINKED_CAPTURE' },
    { id: 'sandbox:MERCHANT123:WHREVIEW2', environment: 'sandbox', merchant_id: MERCHANT, event_type: 'PAYMENT.SALE.REFUNDED',
      payload: { id: 'WHREVIEW2', resource: { id: 'X' } }, status: 'needs_review', error_code: 'ADJUSTMENT_NOT_READY', attempt_count: 10 },
  ]);
  assert.equal((await paypal.verifiedContributionSnapshot('sandbox')).eligibleNetOre, null);
  const listed = await review.listPaypalReviewEvents('sandbox');
  assert.deepEqual(listed.items.map((item) => item.id).sort(), ['sandbox:MERCHANT123:WHREVIEW1', 'sandbox:MERCHANT123:WHREVIEW2']);
  assert.ok(listed.items.every((item) => !('payload' in item)), 'review listing never exposes raw payloads');
  await assert.rejects(review.dismissPaypalReviewEvent('sandbox', 'sandbox:MERCHANT123:WHREVIEW1', 1, ' '), /REVIEW_NOTE_REQUIRED/);
  await assert.rejects(review.dismissPaypalReviewEvent('live', 'sandbox:MERCHANT123:WHREVIEW1', 1, 'unrelated'), /INVALID_ID/);
  assert.equal((await review.dismissPaypalReviewEvent('sandbox', 'sandbox:MERCHANT123:WHREVIEW1', 1, 'Unrelated personal transfer')).status, 'dismissed');
  await assert.rejects(review.dismissPaypalReviewEvent('sandbox', 'sandbox:MERCHANT123:WHREVIEW1', 1, 'again'), /REVIEW_EVENT_NOT_FOUND/);
  assert.equal((await review.retryPaypalReviewEvent('sandbox', 'sandbox:MERCHANT123:WHREVIEW2', 1)).status, 'pending');
  const [retried] = await fixture.db.select().from(paypalWebhookInbox).where(eq(paypalWebhookInbox.id, 'sandbox:MERCHANT123:WHREVIEW2'));
  assert.equal(retried.attempt_count, 0);
  assert.equal(retried.resolution, 'retried');
  await fixture.db.update(paypalWebhookInbox).set({ status: 'processed' }).where(eq(paypalWebhookInbox.id, 'sandbox:MERCHANT123:WHREVIEW2'));
  const snapshot = await paypal.verifiedContributionSnapshot('sandbox');
  assert.equal(snapshot.reviewEvents, 0);
  assert.notEqual(snapshot.eligibleNetOre, null);
  assert.equal((await fixture.db.select().from(paypalPostings)).length, postingsBefore, 'review resolution posts nothing');
});

test('gap 7: event recovery follows validated next links and refuses foreign ones', async () => {
  const { paypalWebhookInbox } = await import('../db/schema/index.ts');
  const [setup] = await fixture.db.select().from(paypalReconciliation);
  const priorCursor = setup?.cursor_at ?? null;
  routes['GET /v1/notifications/webhooks-events'] = (url) => url.searchParams.get('page') === '2'
    ? { events: [{ id: 'WHPAGE2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'O2' }, create_time: '2026-10-08T00:00:00Z' }] }
    : { events: [{ id: 'WHPAGE1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'O1' }, create_time: '2026-10-08T00:00:00Z' }],
      links: [{ rel: 'next', href: `https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events?page=2&page_size=100&start_time=${encodeURIComponent(url.searchParams.get('start_time')!)}` }] };
  const [row] = await (await import('../db/client.ts')).db.select().from((await import('../db/schema/index.ts')).paypalConfigs);
  const recovered = await paypal.recoverPaypalEvents(row, new Date(), priorCursor);
  assert.equal(recovered.stored, 2);
  const ids = (await fixture.db.select({ id: paypalWebhookInbox.id }).from(paypalWebhookInbox)).map((item) => item.id);
  assert.ok(ids.includes('sandbox:MERCHANT123:WHPAGE2'));
  for (const href of ['https://evil.example/v1/notifications/webhooks-events?page=2',
    'https://api-m.sandbox.paypal.com/v1/oauth2/token?page=2', 'https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events?redirect=x']) {
    routes['GET /v1/notifications/webhooks-events'] = () => ({ events: [], links: [{ rel: 'next', href }] });
    await assert.rejects(paypal.recoverPaypalEvents(row, new Date(), priorCursor), /NEXT_LINK_INVALID/);
  }
  assert.equal(calls.filter((call) => !call.path.startsWith('/v1/notifications/') && call.path !== '/v1/oauth2/token').length, 0,
    'a foreign next link is never fetched');
});

test('gap 7: subscription transactions paginate and split windows when no next link is given', async () => {
  const sale = (id: string, time: string) => ({ id, status: 'COMPLETED', time,
    amount_with_breakdown: { gross_amount: dkk('50.00'), fee_amount: dkk('2.00'), net_amount: dkk('48.00') } });
  routes['GET /v1/billing/subscriptions/SUBGOOD/transactions'] = (url) => {
    const start = new Date(url.searchParams.get('start_time')!); const end = new Date(url.searchParams.get('end_time')!);
    const all = [sale('PG1', '2026-09-02T00:00:00Z'), sale('PG2', '2026-09-20T00:00:00Z')].filter((item) => new Date(item.time) >= start && new Date(item.time) <= end);
    return all.length > 1 ? { total_pages: 2, transactions: [all[0]] } : { total_pages: 1, transactions: all };
  };
  const items = await paypal.listAllSubscriptionTransactions(config, 'SUBGOOD', new Date('2026-09-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z'));
  assert.deepEqual(items.map((item) => item.id).sort(), ['PG1', 'PG2']);
  routes['GET /v1/billing/subscriptions/SUBGOOD/transactions'] = (url) => url.searchParams.get('page') === '2'
    ? { total_pages: 2, transactions: [sale('PN2', '2026-09-20T00:00:00Z')] }
    : { total_pages: 2, transactions: [sale('PN1', '2026-09-02T00:00:00Z')], links: [{ rel: 'next', href:
      'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/SUBGOOD/transactions?start_time=2026-09-01T00:00:00Z&end_time=2026-09-30T00:00:00Z&page=2' }] };
  const paged = await paypal.listAllSubscriptionTransactions(config, 'SUBGOOD', new Date('2026-09-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z'));
  assert.deepEqual(paged.map((item) => item.id), ['PN1', 'PN2']);
});

test('gap 8: config saves are compare-and-set, keep the write-only secret and append history', async () => {
  const { paypalConfigs, paypalConfigHistory } = await import('../db/schema/index.ts');
  const [before] = await fixture.db.select().from(paypalConfigs);
  const base = { environment: 'sandbox', clientId: 'CLIENT123', merchantId: MERCHANT, webhookId: 'WEBHOOK123' };
  await assert.rejects(paypal.savePaypalConfiguration({ ...base, expectedVersion: before.config_version - 1 }), /CONFIG_VERSION_CONFLICT/);
  await paypal.savePaypalConfiguration({ ...base, expectedVersion: before.config_version }, 1);
  const [after] = await fixture.db.select().from(paypalConfigs);
  assert.equal(after.config_version, before.config_version + 1);
  assert.equal(after.client_secret, before.client_secret, 'omitting the secret keeps the stored ciphertext');
  await assert.rejects(paypal.savePaypalConfiguration({ ...base, clientId: 'NEWCLIENT123', expectedVersion: after.config_version }), /INVALID_CONFIG/,
    'a new client ID requires its own secret');
  await assert.rejects(paypal.setPaypalEnabled('sandbox', true, 1, after.config_version - 1), /CONFIG_VERSION_CONFLICT/);
  await paypal.setPaypalEnabled('sandbox', true, 1, after.config_version);
  const history = await fixture.db.select().from(paypalConfigHistory);
  assert.deepEqual(history.slice(-2).map((row) => [row.action, row.secret_changed, row.actor_user_id]), [['save', false, 1], ['enable', false, 1]]);
  assert.ok(history.every((row) => !Object.values(row).includes('FIXTURESECRET')), 'history never stores the secret');
  // Concurrent saves from the same version: exactly one wins.
  const [current] = await fixture.db.select().from(paypalConfigs);
  const results = await Promise.allSettled([1, 2].map(() => paypal.savePaypalConfiguration({ ...base, expectedVersion: current.config_version })));
  assert.deepEqual(results.map((item) => item.status).sort(), ['fulfilled', 'rejected']);
});

test('gap 8: test-connection is read-only and setup provisioning is idempotent across lost responses', async () => {
  process.env.PORTAL_BASE_URL = 'https://portal.example';
  const setup = await import('./paypalSetup.ts');
  const hookUrl = 'https://portal.example/api/payments/paypal/webhook/sandbox';
  routes['GET /v1/notifications/webhooks'] = () => ({ webhooks: [] });
  routes['GET /v1/notifications/webhooks/WEBHOOK123'] = () => ({ id: 'WEBHOOK123', url: hookUrl,
    event_types: setup.PAYPAL_WEBHOOK_EVENT_TYPES.map((name) => ({ name })) });
  const tested = await setup.testPaypalConnection('sandbox');
  assert.equal(tested.ok, true, JSON.stringify(tested.checks));
  assert.ok(calls.every((call) => call.method === 'GET' || call.path === '/v1/oauth2/token'), 'connection test performs no mutation');
  routes['GET /v1/notifications/webhooks/WEBHOOK123'] = () => ({ id: 'WEBHOOK123', url: 'https://elsewhere.example/hook', event_types: [{ name: '*' }] });
  assert.deepEqual((await setup.testPaypalConnection('sandbox')).checks.find((item) => item.name === 'webhook'), { name: 'webhook', ok: false, code: 'WEBHOOK_URL_MISMATCH' });

  const productRequests: string[] = [];
  let loseResponse = true;
  routes['POST /v1/catalogs/products'] = () => {
    productRequests.push(calls.at(-1)!.requestId!);
    if (loseResponse) { loseResponse = false; return new Response('{}', { status: 502 }); }
    return { id: 'PROD-123' };
  };
  await assert.rejects(setup.provisionPaypalResource('sandbox', 'product'));
  const product = await setup.provisionPaypalResource('sandbox', 'product');
  assert.equal(product.providerId, 'PROD-123');
  assert.equal(productRequests.length, 2);
  assert.equal(productRequests[0], productRequests[1], 'the retry reuses the persisted PayPal-Request-Id');
  assert.equal((await setup.provisionPaypalResource('sandbox', 'product')).created, false);
  assert.equal(productRequests.length, 2, 'an existing product is never recreated');

  let planBody: any = null;
  routes['POST /v1/billing/plans'] = (_url, body) => { planBody = body; return { id: 'PLAN-50', status: 'ACTIVE', ...body }; };
  const plan = await setup.provisionPaypalResource('sandbox', 'plan', { amount: '50.00' });
  assert.equal(plan.providerId, 'PLAN-50');
  assert.equal(planBody.payment_preferences.auto_bill_outstanding, false);
  assert.equal(planBody.billing_cycles.length, 1);
  assert.equal(planBody.billing_cycles[0].pricing_scheme.fixed_price.currency_code, 'DKK');
  await assert.rejects(setup.provisionPaypalResource('sandbox', 'plan', { amount: '0.01' }), /AMOUNT_OUT_OF_RANGE/);

  routes['GET /v1/notifications/webhooks'] = () => ({ webhooks: [{ id: 'EXISTINGHOOK', url: hookUrl }] });
  routes['POST /v1/notifications/webhooks'] = () => assert.fail('an existing registration for the URL is reused');
  assert.equal((await setup.provisionPaypalResource('sandbox', 'webhook')).providerId, 'EXISTINGHOOK');
  await assert.rejects(setup.provisionPaypalResource('sandbox', 'anything'), /INVALID_SETUP_KIND/);
});
