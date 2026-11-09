import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import signature from 'cookie-signature';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { KOFI_SAMPLE_TRANSACTION_ID, KOFI_TEST_TOKEN, kofiEvent, kofiFormBody, kofiKey, kofiShopOrderEvent, kofiSubscriptionEvent,
  kofiTimestamp } from '../testUtils/kofiFixtures.ts';
import { kofiConfig, kofiMemberEmails, manualContributions, paypalMonthAllocations, paypalPostings, paypalTransactions, paypalWebhookInbox,
  users } from '../db/schema/index.ts';

// Ko-fi integration on the real middleware stack, assembled in the same order
// as src/index.ts: both provider ingresses first, then JSON, the cookie
// session, CSRF, live-user hydration and the payments router. A throwaway
// PostgreSQL database holds all state. There is no network: any fetch fails.
process.env.SECRET_ENCRYPTION_KEY = '79'.repeat(32);
process.env.ALLOWED_ORIGIN = 'https://portal.example';
process.env.KOFI_WEBHOOK_RATE_LIMIT_PER_MINUTE = '100000';
process.env.KOFI_WEBHOOK_GLOBAL_RATE_LIMIT_PER_MINUTE = '100000';
const SECRET = 'kofi-integration-session-secret';
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());
globalThis.fetch = (async (url: string | URL | Request) => { throw new Error(`unexpected network call to ${String(url)}`); }) as typeof fetch;

const { default: paymentsRoutes } = await import('./payments.ts');
const { default: paypalWebhookRoutes } = await import('./paymentsWebhook.ts');
const { default: kofiWebhookRoutes } = await import('./kofiWebhook.ts');
const { DrizzleSessionStore } = await import('../db/sessionStore.ts');
const { csrfProtection } = await import('../middleware/requestSecurity.ts');
const { enforceTwoFactorEnrollmentOnly } = await import('../middleware/twoFactorEnrollment.ts');
const { requestContext } = await import('../utils/logger.ts');
const { db } = await import('../db/client.ts');
const kofi = await import('../services/kofi.ts');
const kofiAdmin = await import('../services/kofiAdmin.ts');
const paypal = await import('../services/paypal.ts');
const { waitForBackgroundWork } = await import('../services/backgroundWork.ts');
const { monthlyEnergyFunding } = await import('../services/energyFunding.ts');
const { allocationMonth, recalculatePaypalAllocations } = await import('../services/paypalAllocation.ts');

const store = new DrizzleSessionStore();
const app = express();
app.set('trust proxy', 1);
app.use(requestContext);
app.use('/api/payments/paypal/webhook', paypalWebhookRoutes);
app.use('/api/payments/kofi/webhook', kofiWebhookRoutes);
app.use(express.json({ limit: '1mb' }));
app.use(session({ store, secret: SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 24 * 60 * 60 * 1000 } }));
app.use(csrfProtection({ allowedOrigin: process.env.ALLOWED_ORIGIN }));
app.use(async (req, _res, next) => {
  if (!req.session?.userId) return next();
  const [user] = await db.select({ username: users.username, is_admin: users.is_admin }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!user) return req.session.destroy(() => next());
  req.session.username = user.username; req.session.isAdmin = user.is_admin === true;
  next();
});
app.use(enforceTwoFactorEnrollmentOnly);
app.use('/api/payments', paymentsRoutes);

async function login(sid: string, data: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => store.set(sid, { cookie: { originalMaxAge: 86_400_000, expires: new Date(Date.now() + 86_400_000) },
    ...data } as any, (err?: unknown) => (err ? reject(err) : resolve())));
  return `connect.sid=${encodeURIComponent(`s:${signature.sign(sid, SECRET)}`)}`;
}
const ORIGIN = { Origin: 'https://portal.example' };
const ANDERS = 1; const ADMIN = 2; const BIRGIT = 3;
const ANDERS_EMAIL = 'anders@example.dk';
let anders = ''; let admin = ''; let birgit = '';

const hook = (event: unknown) => request(app).post('/api/payments/kofi/webhook').set('x-forwarded-proto', 'https').type('form').send(kofiFormBody(event));
/** Delivers one event and lets the Ko-fi worker finish it. */
async function deliver(event: Record<string, unknown>) {
  const response = await hook(event);
  assert.equal(response.status, 200, `delivery acknowledged (got ${response.status})`);
  assert.equal(response.text, '', 'the acknowledgement has no body');
  await waitForBackgroundWork();
  await kofi.processKofiInbox();
  return `live:kofi:${String(event.message_id)}`;
}
const adminGet = (path: string) => request(app).get(`/api/payments/admin/kofi${path}`).set('Cookie', admin);
const adminPost = (path: string, body: unknown = {}) => request(app).post(`/api/payments/admin/kofi${path}`).set('Cookie', admin).set(ORIGIN).send(body as object);
const reviewPath = (id: string, action: string) => `/review/${encodeURIComponent(id)}/${action}`;
const inbox = () => fixture.db.select().from(paypalWebhookInbox);
const inboxRow = async (id: string) => (await fixture.db.select().from(paypalWebhookInbox).where(eq(paypalWebhookInbox.id, id)))[0];
const receipts = () => fixture.db.select().from(paypalTransactions).orderBy(paypalTransactions.id);
const postings = async () => (await fixture.db.select().from(paypalPostings)).map((row) => `${row.merchant_id}:${row.posting_kind}:${row.amount_ore}`).sort();
const receiptFor = async (event: Record<string, unknown>) => (await fixture.db.select().from(paypalTransactions)
  .where(eq(paypalTransactions.provider_transaction_id, kofiKey(event.kofi_transaction_id))))[0];
const reviewItems = async (status = 'needs_review') => (await adminGet(`/review?status=${status}`)).body.items as any[];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());

/** Every test starts from an empty ledger and inbox, with Ko-fi enabled and only Anders' email linked. */
async function reset() {
  await waitForBackgroundWork();
  await fixture.db.delete(paypalMonthAllocations);
  await fixture.db.delete(paypalPostings);
  await fixture.db.delete(paypalTransactions);
  await fixture.db.delete(paypalWebhookInbox);
  await fixture.db.delete(manualContributions);
  await fixture.db.delete(kofiMemberEmails);
  await kofi.saveKofiConfiguration({ pageUrl: 'https://ko-fi.com/homelab', verificationToken: KOFI_TEST_TOKEN }, ADMIN);
  await kofi.setKofiEnabled(true, ADMIN);
  await kofiAdmin.addKofiMemberEmail({ userId: ANDERS, email: ANDERS_EMAIL }, ADMIN);
}

test.before(async () => {
  await fixture.db.insert(users).values([
    { id: ANDERS, username: 'anders', password: 'unused' }, { id: ADMIN, username: 'admin-kofi', password: 'unused', is_admin: true },
    { id: BIRGIT, username: 'birgit', password: 'unused' },
  ]);
  anders = await login('sid-anders', { userId: ANDERS });
  admin = await login('sid-admin', { userId: ADMIN, reauthenticatedAt: Date.now() });
  birgit = await login('sid-birgit', { userId: BIRGIT });
});
test.beforeEach(reset);

test('valid DKK donation from a linked email is recorded once as a live kofi receipt with unknown net', async () => {
  const event = kofiEvent({ email: ' Anders@Example.DK ', amount: '50.00' });
  const id = await deliver(event);
  const rows = await receipts();
  assert.equal(rows.length, 1);
  const [receipt] = rows;
  assert.deepEqual({ environment: receipt.environment, merchant: receipt.merchant_id, ref: receipt.provider_transaction_id, kind: receipt.provider_kind,
    status: receipt.status, currency: receipt.currency, gross: receipt.gross_ore, fee: receipt.fee_ore, net: receipt.net_ore, user: receipt.user_id,
    intent: receipt.intent_id, originalAmount: receipt.original_amount, originalCurrency: receipt.original_currency },
  { environment: 'live', merchant: 'kofi', ref: kofiKey(event.kofi_transaction_id), kind: 'kofi_donation', status: 'net_unresolved', currency: 'DKK',
    gross: 5000, fee: null, net: null, user: ANDERS, intent: null, originalAmount: null, originalCurrency: null });
  assert.equal(receipt.effective_at?.toISOString().slice(0, 19), String(event.timestamp).slice(0, 19));
  assert.deepEqual(await postings(), [], 'nothing reaches the ledger while the fee is unknown');
  const stored = await inboxRow(id);
  assert.deepEqual({ status: stored.status, source: stored.source, type: stored.event_type, resource: stored.resource_id, error: stored.error_code },
    { status: 'processed', source: 'kofi_webhook', type: 'Donation', resource: event.kofi_transaction_id, error: null });
  const snapshot = await paypal.verifiedContributionSnapshot('live');
  assert.equal(snapshot.grossOre, 0, 'a missing fee is never treated as zero');
  assert.equal(snapshot.unresolvedTransactions, 1);
  assert.equal(snapshot.eligibleNetOre, null);
  const listed = (await adminGet('/receipts')).body;
  assert.equal(listed.nextOffset, null);
  assert.deepEqual({ ...listed.items[0], effectiveAt: null, observedAt: null }, { id: receipt.id, transactionRef: kofiKey(event.kofi_transaction_id),
    kind: 'donation', status: 'net_unresolved', userId: ANDERS, username: 'anders', grossOre: 5000, feeOre: null, netOre: null, effectiveAt: null,
    observedAt: null, note: null, originalAmount: null, originalCurrency: null });
  const status = (await adminGet('/config')).body;
  assert.deepEqual(status.counts, { pending: 0, needsReview: 0, awaitingFee: 1, awaitingDkkAmount: 0 });
  assert.equal(status.lastEventType, 'Donation');
  assert.equal(status.lastEventOutcome, 'processed');
});

test('first and recurring subscription payments are recorded as separate receipts for the same member', async () => {
  const first = kofiSubscriptionEvent(true, { email: ANDERS_EMAIL, amount: '25.00' });
  const second = kofiSubscriptionEvent(false, { email: ANDERS_EMAIL, amount: '25.00' });
  await deliver(first); await deliver(second);
  const rows = await receipts();
  assert.deepEqual(rows.map((row) => [row.provider_kind, row.status, row.gross_ore, row.user_id]),
    [['kofi_subscription', 'net_unresolved', 2500, ANDERS], ['kofi_subscription', 'net_unresolved', 2500, ANDERS]]);
  assert.deepEqual(rows.map((row) => row.provider_transaction_id).sort(), [kofiKey(first.kofi_transaction_id), kofiKey(second.kofi_transaction_id)].sort());
  assert.deepEqual((await adminGet('/receipts')).body.items.map((item: any) => item.kind), ['subscription', 'subscription']);
});

test('wrong or missing verification token returns 401 and stores nothing', async () => {
  const { verification_token: _token, ...withoutToken } = kofiEvent({ email: ANDERS_EMAIL });
  for (const event of [kofiEvent({ verification_token: 'not-the-token' }), withoutToken, kofiEvent({ verification_token: 12345 }),
    kofiEvent({ verification_token: '' }), kofiEvent({ verification_token: `${KOFI_TEST_TOKEN} ` }), kofiEvent({ verification_token: [KOFI_TEST_TOKEN] })]) {
    const response = await hook(event);
    assert.equal(response.status, 401);
    assert.equal(response.text, '', 'the refusal reveals nothing');
  }
  // No stored token: nothing can be verified, so even the right token is refused.
  await fixture.db.update(kofiConfig).set({ verification_token: null });
  assert.equal((await hook(kofiEvent({ email: ANDERS_EMAIL }))).status, 401);
  await waitForBackgroundWork();
  assert.equal((await inbox()).length, 0);
  assert.equal((await receipts()).length, 0);
  assert.deepEqual(await postings(), []);
  const status = (await adminGet('/config')).body;
  assert.equal(status.lastErrorCode, 'INVALID_TOKEN');
  assert.ok(status.lastErrorAt);
  assert.equal(status.tokenStored, false);
});

test('duplicate message_id is acknowledged with 200 and creates no second receipt or posting', async () => {
  const event = kofiEvent({ email: ANDERS_EMAIL, amount: '40.00' });
  const id = await deliver(event);
  const again = await hook(event);
  assert.equal(again.status, 200);
  assert.equal(again.text, '');
  await waitForBackgroundWork(); await kofi.processKofiInbox();
  assert.equal((await inbox()).length, 1);
  assert.equal((await receipts()).length, 1);
  const [receipt] = await receipts();
  assert.equal((await adminPost(`/receipts/${receipt.id}/fee`, { fee: '1.50' })).status, 200);
  assert.deepEqual(await postings(), ['kofi:fee:-150', 'kofi:gross:4000']);
  // A redelivery after posting, and a restored backup that brings the row back as pending, change nothing.
  assert.equal((await hook(event)).status, 200);
  // Every acknowledged delivery starts a worker pass in the background; let it finish before staging the replay.
  await waitForBackgroundWork();
  await fixture.db.update(paypalWebhookInbox).set({ status: 'pending', processed_at: null }).where(eq(paypalWebhookInbox.id, id));
  await Promise.all([kofi.processKofiInbox(), kofi.processKofiInbox(), kofi.processKofiInbox()]);
  assert.equal((await receipts()).length, 1);
  assert.deepEqual(await postings(), ['kofi:fee:-150', 'kofi:gross:4000']);
  assert.equal((await inboxRow(id)).status, 'processed');
});

test('the same kofi_transaction_id under a new message_id creates no second economic reference', async () => {
  const transactionId = '0a1fac0c-f960-4506-a60e-824979a74e71';
  const first = kofiEvent({ email: ANDERS_EMAIL, amount: '30.00', kofi_transaction_id: transactionId });
  // Ko-fi's id is case-insensitive for us: the same payment in another casing is the same reference.
  const second = kofiEvent({ email: ANDERS_EMAIL, amount: '30.00', kofi_transaction_id: transactionId.toUpperCase() });
  for (const event of [first, second]) assert.equal((await hook(event)).status, 200);
  await waitForBackgroundWork();
  await Promise.all([kofi.processKofiInbox(), kofi.processKofiInbox()]);
  assert.equal((await inbox()).length, 2);
  const rows = await receipts();
  assert.equal(rows.length, 1, 'one economic reference');
  assert.equal(rows[0].provider_transaction_id, '0A1FAC0CF9604506A60E824979A74E71');
  // Whichever worker came second either saw the committed receipt or waited on its unique index; both end processed.
  assert.ok((await inbox()).every((row) => row.status === 'processed' && [null, 'DUPLICATE_TRANSACTION'].includes(row.error_code)));
  const later = await deliver(kofiEvent({ email: ANDERS_EMAIL, amount: '30.00', kofi_transaction_id: transactionId }));
  assert.deepEqual([(await inboxRow(later)).status, (await inboxRow(later)).error_code], ['processed', 'DUPLICATE_TRANSACTION']);
  assert.equal((await receipts()).length, 1);
  // The same reference with a different amount is a conflict for the operator, never a second receipt.
  const conflict = await deliver(kofiEvent({ email: ANDERS_EMAIL, amount: '35.00', kofi_transaction_id: transactionId }));
  assert.deepEqual([(await inboxRow(conflict)).status, (await inboxRow(conflict)).error_code], ['needs_review', 'TRANSACTION_CONFLICT']);
  const kind = await deliver(kofiSubscriptionEvent(false, { email: ANDERS_EMAIL, amount: '30.00', kofi_transaction_id: transactionId }));
  assert.equal((await inboxRow(kind)).error_code, 'TRANSACTION_CONFLICT');
  assert.equal((await receipts()).length, 1);
  assert.equal((await receipts())[0].gross_ore, 3000);
  const items = await reviewItems();
  assert.ok(items.every((item) => item.linkable === false && item.settleable === false));
});

test('non-DKK currency, Commission, Shop Order, unknown type and bad amount go to review and never post', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [kofiEvent({ email: ANDERS_EMAIL, currency: 'EUR', amount: '5.00' }), 'CURRENCY_NOT_DKK'],
    [kofiEvent({ email: ANDERS_EMAIL, currency: 'dkk' }), 'INVALID_CURRENCY'],
    [kofiEvent({ email: ANDERS_EMAIL, currency: 'EURO' }), 'INVALID_CURRENCY'],
    [kofiEvent({ email: ANDERS_EMAIL, currency: null }), 'INVALID_CURRENCY'],
    [kofiEvent({ email: ANDERS_EMAIL, type: 'Commission' }), 'UNSUPPORTED_TYPE'],
    [kofiShopOrderEvent({ email: ANDERS_EMAIL }), 'UNSUPPORTED_TYPE'],
    [kofiEvent({ email: ANDERS_EMAIL, type: 'Refund' }), 'UNKNOWN_TYPE'],
    [kofiEvent({ email: ANDERS_EMAIL, amount: '50,00' }), 'INVALID_AMOUNT'],
    [kofiEvent({ email: ANDERS_EMAIL, amount: 50 }), 'INVALID_AMOUNT'],
    [kofiEvent({ email: ANDERS_EMAIL, amount: '0.50' }), 'INVALID_AMOUNT'],
    [kofiEvent({ email: ANDERS_EMAIL, currency: 'EUR', amount: '0.00' }), 'INVALID_AMOUNT'],
    [kofiEvent({ email: ANDERS_EMAIL, kofi_transaction_id: 'not a valid id' }), 'INVALID_TRANSACTION_ID'],
    [kofiEvent({ email: ANDERS_EMAIL, timestamp: 'last tuesday' }), 'INVALID_TIMESTAMP'],
    [kofiEvent({ email: ANDERS_EMAIL, timestamp: kofiTimestamp(new Date(Date.now() + 3 * 86_400_000)) }), 'INVALID_TIMESTAMP'],
  ];
  for (const [event, reason] of cases) {
    const row = await inboxRow(await deliver(event));
    assert.deepEqual([row.status, row.error_code], ['needs_review', reason], JSON.stringify({ type: event.type, currency: event.currency, amount: event.amount }));
  }
  assert.equal((await receipts()).length, 0, 'no review item is ever recorded automatically');
  assert.deepEqual(await postings(), []);
  const items = await reviewItems();
  assert.equal(items.length, cases.length);
  assert.ok(items.every((item) => item.status === 'needs_review' && item.linkable === false && item.payloadRetained === true));
  // Only a well-formed payment in another currency can be recorded in DKK by the administrator.
  assert.deepEqual(items.filter((item) => item.settleable).map((item) => [item.reason, item.amount, item.currency]), [['CURRENCY_NOT_DKK', '5.00', 'EUR']]);
  const snapshot = await paypal.verifiedContributionSnapshot('live');
  assert.equal(snapshot.reviewEvents, cases.length);
  assert.equal(snapshot.eligibleNetOre, null, 'review items block finalized net');
  const status = (await adminGet('/config')).body;
  assert.deepEqual(status.counts, { pending: 0, needsReview: cases.length, awaitingFee: 0, awaitingDkkAmount: 1 });
});

test('unmatched or missing email is held for review; admin link records the receipt and remembers the email', async () => {
  const unmatched = kofiEvent({ email: 'Newcomer@Example.dk', from_name: 'Birgit B', message: 'Tak!', amount: '75.00' });
  const { email: _email, ...noEmail } = kofiEvent({ amount: '20.00' });
  const first = await deliver(unmatched);
  const second = await deliver(noEmail);
  assert.equal((await receipts()).length, 0);
  let items = await reviewItems();
  const shown = items.find((item) => item.id === first);
  assert.deepEqual({ reason: shown.reason, linkable: shown.linkable, settleable: shown.settleable, amount: shown.amount, currency: shown.currency,
    fromName: shown.fromName, email: shown.email, message: shown.message, tierName: shown.tierName, sub: shown.isSubscriptionPayment,
    firstSub: shown.isFirstSubscriptionPayment, matchedUserId: shown.matchedUserId, matchedUsername: shown.matchedUsername, eventType: shown.eventType,
    kofiTransactionId: shown.kofiTransactionId, payloadRetained: shown.payloadRetained },
  { reason: 'MEMBER_UNMATCHED', linkable: true, settleable: false, amount: '75.00', currency: 'DKK', fromName: 'Birgit B', email: 'Newcomer@Example.dk',
    message: 'Tak!', tierName: null, sub: false, firstSub: false, matchedUserId: null, matchedUsername: null, eventType: 'Donation',
    kofiTransactionId: unmatched.kofi_transaction_id, payloadRetained: true });
  assert.deepEqual([items.find((item) => item.id === second).reason, items.find((item) => item.id === second).linkable], ['EMAIL_MISSING', true]);

  // Input and state errors change nothing.
  assert.equal((await adminPost(reviewPath(first, 'link'), {})).body.error, 'INVALID_USER');
  assert.equal((await adminPost(reviewPath(first, 'link'), { userId: 'birgit' })).body.error, 'INVALID_USER');
  const missing = await adminPost(reviewPath(first, 'link'), { userId: 999 });
  assert.deepEqual([missing.status, missing.body.error], [404, 'USER_NOT_FOUND']);
  assert.equal((await adminPost('/review/not-an-id/link', { userId: BIRGIT })).body.error, 'INVALID_ID');
  assert.equal((await adminPost(reviewPath('live:kofi:unknown-message', 'link'), { userId: BIRGIT })).status, 404);
  assert.equal((await receipts()).length, 0);

  const linked = await adminPost(reviewPath(first, 'link'), { userId: BIRGIT });
  assert.equal(linked.status, 200);
  const receipt = await receiptFor(unmatched);
  assert.deepEqual(linked.body, { status: 'linked', receiptId: receipt.id });
  assert.deepEqual([receipt.user_id, receipt.status, receipt.gross_ore], [BIRGIT, 'net_unresolved', 7500]);
  const resolved = await inboxRow(first);
  assert.deepEqual([resolved.status, resolved.resolution, resolved.resolved_by], ['processed', 'linked', ADMIN]);
  const again = await adminPost(reviewPath(first, 'link'), { userId: BIRGIT });
  assert.deepEqual([again.status, again.body.error], [404, 'REVIEW_EVENT_NOT_FOUND'], 'an event is linked once');
  const members = (await adminGet('/members')).body.items;
  assert.deepEqual(members.map((item: any) => [item.userId, item.username, item.emailHint, item.source]).sort(),
    [[ANDERS, 'anders', 'an…@example.dk', 'admin_entry'], [BIRGIT, 'birgit', 'ne…@example.dk', 'admin_link']]);
  // The next payment from that email matches by itself.
  const next = kofiEvent({ email: 'newcomer@example.dk', amount: '10.00' });
  assert.equal((await inboxRow(await deliver(next))).status, 'processed');
  assert.equal((await receiptFor(next)).user_id, BIRGIT);

  // An event without an email can be linked, but there is nothing to remember.
  assert.equal((await adminPost(reviewPath(second, 'link'), { userId: ANDERS })).status, 200);
  assert.equal((await receiptFor(noEmail)).user_id, ANDERS);
  assert.equal((await adminGet('/members')).body.items.length, 2);

  // A queued event whose email was linked to someone else meanwhile: remembering it for another member is refused.
  const late = kofiEvent({ email: 'late@example.dk', amount: '15.00' });
  const lateId = await deliver(late);
  const added = await adminPost('/members', { userId: ANDERS, email: 'LATE@example.dk' });
  assert.equal(added.status, 201);
  assert.deepEqual([added.body.userId, added.body.username, added.body.emailHint, added.body.source], [ANDERS, 'anders', 'la…@example.dk', 'admin_entry']);
  items = await reviewItems();
  assert.deepEqual([items[0].matchedUserId, items[0].matchedUsername], [ANDERS, 'anders'], 'the list shows the member the email is bound to now');
  const refused = await adminPost(reviewPath(lateId, 'link'), { userId: BIRGIT });
  assert.deepEqual([refused.status, refused.body.error], [409, 'EMAIL_ALREADY_LINKED']);
  assert.equal(await receiptFor(late), undefined, 'the refused link recorded nothing');
  // Retry sends it back through matching, which now succeeds.
  assert.deepEqual((await adminPost(reviewPath(lateId, 'retry'))).body, { status: 'pending' });
  await waitForBackgroundWork(); await kofi.processKofiInbox();
  assert.equal((await inboxRow(lateId)).status, 'processed');
  assert.equal((await receiptFor(late)).user_id, ANDERS);
  assert.equal((await adminPost(reviewPath(lateId, 'retry'))).status, 404);

  // Linking without remembering leaves the mapping alone; a duplicate or foreign address is refused on entry.
  const once = kofiEvent({ email: 'once@example.dk', amount: '12.00' });
  assert.equal((await adminPost(reviewPath(await deliver(once), 'link'), { userId: BIRGIT, rememberEmail: false })).status, 200);
  assert.equal((await adminGet('/members')).body.items.length, 3);
  assert.equal((await adminPost('/members', { userId: BIRGIT, email: 'late@example.dk' })).body.error, 'EMAIL_ALREADY_LINKED');
  assert.equal((await adminPost('/members', { userId: BIRGIT, email: 'not-an-email' })).body.error, 'INVALID_EMAIL');
  assert.equal((await adminPost('/members', { userId: 999, email: 'x@example.dk' })).body.error, 'USER_NOT_FOUND');
  const removed = await request(app).delete(`/api/payments/admin/kofi/members/${added.body.id}`).set('Cookie', admin).set(ORIGIN);
  assert.deepEqual([removed.status, removed.body], [200, { removed: true }]);
  assert.equal((await request(app).delete(`/api/payments/admin/kofi/members/${added.body.id}`).set('Cookie', admin).set(ORIGIN)).body.error, 'MEMBER_EMAIL_NOT_FOUND');
  // With the mapping gone, the address is unmatched again.
  assert.equal((await inboxRow(await deliver(kofiEvent({ email: 'late@example.dk' })))).error_code, 'MEMBER_UNMATCHED');
});

test('link without a member records an unattributed receipt', async () => {
  const event = kofiEvent({ email: 'stranger@example.org', amount: '100.00' });
  const id = await deliver(event);
  const linked = await adminPost(reviewPath(id, 'link'), { userId: null });
  assert.equal(linked.status, 200);
  const receipt = await receiptFor(event);
  assert.deepEqual([receipt.user_id, receipt.status, receipt.gross_ore], [null, 'net_unresolved', 10000]);
  assert.equal((await fixture.db.select().from(kofiMemberEmails)).length, 1, 'no email is remembered without a member');
  assert.deepEqual([(await adminGet('/receipts')).body.items[0].userId, (await adminGet('/receipts')).body.items[0].username], [null, null]);
});

test('dismissing a Ko-fi review item posts nothing and unblocks net', async () => {
  const id = await deliver(kofiEvent({ email: ANDERS_EMAIL, type: 'Commission' }));
  assert.equal((await paypal.verifiedContributionSnapshot('live')).eligibleNetOre, null);
  assert.equal((await adminPost(reviewPath(id, 'dismiss'), {})).body.error, 'REVIEW_NOTE_REQUIRED');
  assert.equal((await adminPost(reviewPath(id, 'dismiss'), { note: 'x' })).body.error, 'REVIEW_NOTE_REQUIRED');
  assert.equal((await adminPost('/review/live:MERCHANT123:WH1/dismiss', { note: 'not a Ko-fi id' })).body.error, 'INVALID_ID');
  const dismissed = await adminPost(reviewPath(id, 'dismiss'), { note: 'Commission for artwork, not lab support' });
  assert.deepEqual([dismissed.status, dismissed.body], [200, { status: 'dismissed' }]);
  const row = await inboxRow(id);
  assert.deepEqual([row.status, row.resolution, row.resolution_note, row.resolved_by], ['dismissed', 'dismissed', 'Commission for artwork, not lab support', ADMIN]);
  assert.equal((await receipts()).length, 0);
  assert.deepEqual(await postings(), []);
  const snapshot = await paypal.verifiedContributionSnapshot('live');
  assert.deepEqual([snapshot.reviewEvents, snapshot.eligibleNetOre], [0, 0]);
  assert.deepEqual(await reviewItems(), []);
  const resolved = await reviewItems('resolved');
  assert.deepEqual([resolved[0].id, resolved[0].status, resolved[0].reason, resolved[0].resolution, resolved[0].linkable], [id, 'dismissed', 'UNSUPPORTED_TYPE', 'dismissed', false]);
  assert.equal((await reviewItems('all')).length, 1);
  assert.equal((await adminGet('/review?status=bogus')).body.error, 'INVALID_STATUS');
  assert.equal((await adminGet('/review?offset=-1')).body.error, 'INVALID_OFFSET');
  assert.equal((await adminPost(reviewPath(id, 'dismiss'), { note: 'again please' })).status, 404);
});

test('an unresolved Ko-fi receipt makes monthly funding Unknown and the allocation unresolved until the fee is entered', async () => {
  const month = allocationMonth(new Date());
  const event = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00' });
  await deliver(event);
  let funding = await monthlyEnergyFunding(month);
  assert.deepEqual([funding.unresolvedOre, funding.eligibleNetOre, funding.grossOre, funding.knownNetOre], [null, null, 0, 0],
    'the budget shows Unknown, and the gross is not counted as if the fee were zero');
  const blocked = await recalculatePaypalAllocations(month);
  assert.deepEqual(blocked.created.map((row) => row.status), ['unresolved']);
  const [allocation] = await fixture.db.select().from(paypalMonthAllocations);
  assert.deepEqual([allocation.status, allocation.unresolved_count, allocation.received_net_ore], ['unresolved', 1, 0]);
  funding = await monthlyEnergyFunding(month);
  assert.deepEqual([funding.status, funding.unresolvedOre], ['partial', null]);
  const health = (await request(app).get('/api/payments/admin/health?environment=live').set('Cookie', admin)).body;
  assert.equal(health.unresolvedTransactions, 1, 'counted with the other unknown-net payments');

  const receipt = await receiptFor(event);
  assert.equal((await adminPost(`/receipts/${receipt.id}/fee`, { fee: '1.95' })).status, 200);
  const resolved = await recalculatePaypalAllocations(month);
  assert.notEqual(resolved.created[0].status, 'unresolved');
  funding = await monthlyEnergyFunding(month);
  assert.deepEqual([funding.unresolvedOre, funding.grossOre, funding.feeDebitsOre, funding.knownNetOre], [0, 5000, 195, 4805]);
  const snapshot = await paypal.verifiedContributionSnapshot('live');
  assert.deepEqual([snapshot.unresolvedTransactions, snapshot.knownNetOre, snapshot.eligibleNetOre], [0, 4805, 4805]);
});

test('entering the fee posts gross and fee exactly once; reversal appends linked negative postings; void posts nothing', async () => {
  const paid = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00' });
  const other = kofiEvent({ email: ANDERS_EMAIL, amount: '20.00' });
  await deliver(paid); await deliver(other);
  const a = await receiptFor(paid); const b = await receiptFor(other);

  assert.equal((await adminPost('/receipts/abc/fee', { fee: '1.95' })).body.error, 'INVALID_ID');
  assert.equal((await adminPost('/receipts/999999/fee', { fee: '1.95' })).body.error, 'KOFI_RECEIPT_NOT_FOUND');
  for (const fee of ['1,95', 1.95, '-1.00', undefined]) assert.equal((await adminPost(`/receipts/${a.id}/fee`, { fee })).body.error, 'INVALID_AMOUNT', String(fee));
  const tooMuch = await adminPost(`/receipts/${a.id}/fee`, { fee: '50.01' });
  assert.deepEqual([tooMuch.status, tooMuch.body.error], [400, 'FEE_OUT_OF_RANGE']);
  assert.equal((await adminPost(`/receipts/${a.id}/fee`, { fee: '1.95', note: 'x'.repeat(501) })).body.error, 'INVALID_NOTE');
  assert.deepEqual(await postings(), []);

  const fee = await adminPost(`/receipts/${a.id}/fee`, { fee: '1.95', note: 'Stripe payout 9 Nov' });
  assert.deepEqual([fee.status, fee.body], [200, { id: a.id, status: 'posted', grossOre: 5000, feeOre: 195, netOre: 4805 }]);
  assert.deepEqual(await postings(), ['kofi:fee:-195', 'kofi:gross:5000']);
  const posted = await fixture.db.select().from(paypalPostings);
  assert.ok(posted.every((row) => row.environment === 'live' && row.currency === 'DKK' && row.user_id === ANDERS && row.verification === 'kofi_admin_fee' &&
    row.provider_transaction_id === kofiKey(paid.kofi_transaction_id)));
  const twice = await adminPost(`/receipts/${a.id}/fee`, { fee: '2.00' });
  assert.deepEqual([twice.status, twice.body.error], [409, 'KOFI_RECEIPT_NOT_UNRESOLVED']);
  assert.deepEqual(await postings(), ['kofi:fee:-195', 'kofi:gross:5000'], 'a second fee entry posts nothing');
  assert.deepEqual((await adminGet('/receipts?status=posted')).body.items.map((item: any) => [item.id, item.status, item.feeOre, item.netOre, item.note]),
    [[a.id, 'posted', 195, 4805, 'Stripe payout 9 Nov']]);

  assert.equal((await adminPost(`/receipts/${a.id}/reverse`, { reason: 'no' })).body.error, 'REASON_REQUIRED');
  assert.equal((await adminPost(`/receipts/${a.id}/reverse`, { reason: 'refunded', feeCredit: 'abc' })).body.error, 'INVALID_AMOUNT');
  assert.equal((await adminPost(`/receipts/${a.id}/reverse`, { reason: 'refunded', feeCredit: '1.96' })).body.error, 'FEE_OUT_OF_RANGE');
  const reversed = await adminPost(`/receipts/${a.id}/reverse`, { reason: 'Refunded at the supporter\'s request', feeCredit: '0.95' });
  assert.deepEqual([reversed.status, reversed.body], [200, { id: a.id, status: 'reversed' }]);
  assert.deepEqual(await postings(), ['kofi:fee:-195', 'kofi:fee_credit:95', 'kofi:gross:5000', 'kofi:reversal:-5000'], 'the original postings are kept');
  const linked = (await fixture.db.select().from(paypalPostings)).filter((row) => ['reversal', 'fee_credit'].includes(row.posting_kind));
  assert.ok(linked.every((row) => row.original_transaction_id === kofiKey(paid.kofi_transaction_id) && row.verification === 'kofi_admin_reversal'));
  const [after] = await fixture.db.select().from(paypalTransactions).where(eq(paypalTransactions.id, a.id));
  assert.deepEqual([after.status, after.admin_note], ['reversed', 'Stripe payout 9 Nov\nReversed: Refunded at the supporter\'s request']);
  const second = await adminPost(`/receipts/${a.id}/reverse`, { reason: 'again please' });
  assert.deepEqual([second.status, second.body.error], [409, 'KOFI_RECEIPT_ALREADY_REVERSED']);

  // A receipt still waiting for its fee never entered the ledger: voiding it posts nothing.
  const voided = await adminPost(`/receipts/${b.id}/reverse`, { reason: 'Recorded by mistake' });
  assert.deepEqual(voided.body, { id: b.id, status: 'voided' });
  assert.equal((await postings()).length, 4);
  assert.equal((await adminPost(`/receipts/${b.id}/fee`, { fee: '0.00' })).body.error, 'KOFI_RECEIPT_NOT_UNRESOLVED');
  assert.equal((await adminPost(`/receipts/${b.id}/reverse`, { reason: 'again please' })).body.error, 'KOFI_RECEIPT_ALREADY_REVERSED');
  assert.equal((await postings()).length, 4);
  const listed = (await adminGet('/receipts?status=all')).body.items;
  assert.deepEqual(listed.map((item: any) => item.status).sort(), ['reversed', 'voided'], 'the reversal row itself is not listed as a receipt');
  assert.equal((await adminGet('/receipts')).body.items.length, 0);
  assert.equal((await adminGet('/receipts?status=nope')).body.error, 'INVALID_STATUS');
  const snapshot = await paypal.verifiedContributionSnapshot('live');
  assert.deepEqual([snapshot.unresolvedTransactions, snapshot.knownNetOre], [0, -100], 'the fee that was not refunded is the only loss');
  // An explicit zero fee is a statement by the administrator, not a default.
  const free = kofiEvent({ email: ANDERS_EMAIL, amount: '10.00' });
  await deliver(free);
  assert.deepEqual((await adminPost(`/receipts/${(await receiptFor(free)).id}/fee`, { fee: '0.00' })).body.netOre, 1000);
});

test('a manual report or record with the Ko-fi transaction reference is refused; a same-amount nearby manual receipt needs acknowledgeSimilar', async () => {
  const event = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00', kofi_transaction_id: '3f2b1c9d-aaaa-4bbb-8ccc-0123456789ab' });
  await deliver(event);
  const report = (reference: string, amount = '50.00') => request(app).post('/api/payments/manual-reports').set('Cookie', anders).set(ORIGIN)
    .send({ amount, reference, receivedOn: today });
  for (const reference of ['3f2b1c9d-aaaa-4bbb-8ccc-0123456789ab', '3F2B1C9D-AAAA-4BBB-8CCC-0123456789AB', '3f2b1c9daaaa4bbb8ccc0123456789ab', '3F2B 1C9D AAAA 4BBB 8CCC 0123456789AB']) {
    const response = await report(reference);
    assert.deepEqual([response.status, response.body.error], [409, 'DUPLICATE_PROVIDER_PAYMENT'], reference);
  }
  const recorded = await request(app).post('/api/payments/admin/manual').set('Cookie', admin).set(ORIGIN)
    .send({ amount: '50.00', reference: '3F2B1C9DAAAA4BBB8CCC0123456789AB', receivedOn: today, evidence: 'Ko-fi dashboard' });
  assert.deepEqual([recorded.status, recorded.body.error], [409, 'DUPLICATE_PROVIDER_PAYMENT']);
  assert.equal((await fixture.db.select().from(manualContributions)).length, 0);

  // Same member, same amount, same days, different reference: almost certainly the same money.
  const other = await report('Bank transfer 2026-11 A1');
  assert.equal(other.status, 201);
  const confirm = (body: Record<string, unknown>) => request(app).post(`/api/payments/admin/manual/${other.body.id}/confirm`).set('Cookie', admin).set(ORIGIN).send(body);
  const similar = await confirm({ evidence: 'statement line 3' });
  assert.deepEqual([similar.status, similar.body.error], [409, 'SIMILAR_PROVIDER_PAYMENT'], 'a Ko-fi receipt still waiting for its fee is matched too');
  assert.deepEqual(await postings(), []);
  assert.equal((await confirm({ evidence: 'statement line 3; separate from the Ko-fi payment', acknowledgeSimilar: true })).status, 200);
  assert.deepEqual(await postings(), ['manual:gross:5000']);
  // A different amount, or another member, is not held back.
  const different = await report('Bank transfer 2026-11 B2', '60.00');
  assert.equal((await request(app).post(`/api/payments/admin/manual/${different.body.id}/confirm`).set('Cookie', admin).set(ORIGIN).send({ evidence: 'statement line 4' })).status, 200);
  // A voided Ko-fi receipt no longer counts as similar money, but its reference stays taken.
  const mistaken = kofiEvent({ email: ANDERS_EMAIL, amount: '70.00' });
  await deliver(mistaken);
  assert.equal((await adminPost(`/receipts/${(await receiptFor(mistaken)).id}/reverse`, { reason: 'Recorded twice' })).body.status, 'voided');
  const afterVoid = await report('Bank transfer 2026-11 C3', '70.00');
  assert.equal((await request(app).post(`/api/payments/admin/manual/${afterVoid.body.id}/confirm`).set('Cookie', admin).set(ORIGIN).send({ evidence: 'statement line 5' })).status, 200);
  assert.equal((await report(String(mistaken.kofi_transaction_id), '70.00')).body.error, 'DUPLICATE_PROVIDER_PAYMENT');
});

test('a Ko-fi event whose transaction is already a manual receipt is held as DUPLICATE_MANUAL_RECEIPT', async () => {
  const transactionId = '7c1d2e3f-1111-4222-8333-abcdefabcdef';
  const recorded = await request(app).post('/api/payments/admin/manual').set('Cookie', admin).set(ORIGIN)
    .send({ amount: '50.00', reference: transactionId, receivedOn: today, evidence: 'Ko-fi dashboard, before the webhook was set up', userId: ANDERS });
  assert.equal(recorded.status, 201);
  const id = await deliver(kofiEvent({ email: ANDERS_EMAIL, amount: '50.00', kofi_transaction_id: transactionId }));
  const row = await inboxRow(id);
  assert.deepEqual([row.status, row.error_code], ['needs_review', 'DUPLICATE_MANUAL_RECEIPT']);
  assert.equal((await receipts()).length, 0);
  assert.deepEqual(await postings(), ['manual:gross:5000'], 'the money is counted once');
  const [item] = await reviewItems();
  assert.deepEqual([item.linkable, item.settleable], [false, false]);
  assert.equal((await adminPost(reviewPath(id, 'link'), { userId: ANDERS })).body.error, 'REVIEW_EVENT_NOT_LINKABLE');
  // Also for a payment in another currency: the duplicate reason wins and it cannot be recorded in DKK.
  const foreign = await deliver(kofiEvent({ email: ANDERS_EMAIL, currency: 'EUR', amount: '6.70', kofi_transaction_id: transactionId }));
  assert.equal((await inboxRow(foreign)).error_code, 'DUPLICATE_MANUAL_RECEIPT');
  assert.equal((await adminPost(reviewPath(foreign, 'settle'), { userId: ANDERS, grossDkk: '50.00', fee: '1.00' })).body.error, 'REVIEW_EVENT_NOT_SETTLEABLE');
  // A pending member report with the same reference blocks it as well.
  await fixture.db.delete(manualContributions); await fixture.db.delete(paypalPostings);
  assert.equal((await request(app).post('/api/payments/manual-reports').set('Cookie', anders).set(ORIGIN)
    .send({ amount: '50.00', reference: transactionId, receivedOn: today })).status, 201);
  assert.equal((await inboxRow(await deliver(kofiEvent({ email: ANDERS_EMAIL, kofi_transaction_id: transactionId })))).error_code, 'DUPLICATE_MANUAL_RECEIPT');
});

test('the PayPal inbox worker never consumes Ko-fi events and the PayPal review list does not show them', async () => {
  // Stored without the ingress kick, so only the worker under test can touch it.
  const event = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00' });
  assert.deepEqual(await kofi.storeKofiWebhook(JSON.stringify(event)), { stored: true });
  const id = `live:kofi:${String(event.message_id)}`;
  await paypal.processPaypalInbox(); await paypal.processPaypalInbox();
  let row = await inboxRow(id);
  assert.deepEqual([row.status, row.attempt_count, row.processed_at], ['pending', 0, null], 'the PayPal worker left the Ko-fi event alone');
  assert.equal((await receipts()).length, 0);
  // A Ko-fi claim that looks abandoned is not requeued by the PayPal worker either.
  await fixture.db.update(paypalWebhookInbox).set({ status: 'processing', processing_at: new Date(Date.now() - 3_600_000) }).where(eq(paypalWebhookInbox.id, id));
  await paypal.processPaypalInbox();
  assert.equal((await inboxRow(id)).status, 'processing');
  // The Ko-fi worker requeues its own abandoned claim and records the payment.
  await kofi.processKofiInbox();
  row = await inboxRow(id);
  assert.deepEqual([row.status, row.error_code], ['processed', null]);
  assert.equal((await receipts()).length, 1);

  const reviewId = await deliver(kofiEvent({ email: ANDERS_EMAIL, type: 'Commission' }));
  const paypalList = await request(app).get('/api/payments/admin/review?environment=live&status=all').set('Cookie', admin);
  assert.equal(paypalList.status, 200);
  assert.deepEqual(paypalList.body.items, [], 'Ko-fi events are not in the PayPal review list');
  assert.deepEqual((await reviewItems()).map((item) => item.id), [reviewId]);
  const summary = (await request(app).get('/api/payments/admin/summary').set('Cookie', admin)).body;
  assert.deepEqual([summary.reviewEvents, summary.unresolvedTransactions], [1, 1], 'but they do count as blockers of the live ledger');
  // A PayPal event in the same inbox is still handled by the PayPal worker and never by the Ko-fi worker.
  await fixture.db.insert(paypalWebhookInbox).values({ id: 'live:MERCHANT123:WHKOFI1', environment: 'live', merchant_id: 'MERCHANT123',
    event_type: 'CHECKOUT.ORDER.APPROVED', resource_id: 'ORDER1', payload: { id: 'WHKOFI1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER1' } } });
  await kofi.processKofiInbox();
  assert.equal((await inboxRow('live:MERCHANT123:WHKOFI1')).status, 'pending');
  await paypal.processPaypalInbox();
  assert.equal((await inboxRow('live:MERCHANT123:WHKOFI1')).status, 'processed');
});

test('processed Ko-fi payloads are emptied after 30 days; review payloads are kept; token and shipping are never stored', async () => {
  const paid = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00', from_name: 'Anders A', message: 'Tak for lab', note: KOFI_TEST_TOKEN,
    nested: { echoed: KOFI_TEST_TOKEN, list: [KOFI_TEST_TOKEN, 'kept'], inside: `token=${KOFI_TEST_TOKEN};`, [KOFI_TEST_TOKEN]: 'as a key' } });
  const order = kofiShopOrderEvent({ email: 'buyer@example.org' });
  const paidId = await deliver(paid); const orderId = await deliver(order);
  for (const id of [paidId, orderId]) {
    const payload = (await inboxRow(id)).payload as Record<string, unknown>;
    assert.equal('verification_token' in payload, false);
    assert.equal('shipping' in payload, false, 'the postal address is dropped before storage');
    assert.equal(JSON.stringify(payload).includes(KOFI_TEST_TOKEN), false, 'the token value survives nowhere in the stored event');
    assert.equal(JSON.stringify(payload).includes('Secret Street'), false);
  }
  const kept = (await inboxRow(paidId)).payload as Record<string, any>;
  assert.deepEqual([kept.from_name, kept.email, kept.message, kept.nested.list[1]], ['Anders A', ANDERS_EMAIL, 'Tak for lab', 'kept']);
  assert.deepEqual(((await inboxRow(orderId)).payload as Record<string, any>).shop_items[0].quantity, 1);

  const old = new Date(Date.now() - 31 * 86_400_000);
  await fixture.db.update(paypalWebhookInbox).set({ processed_at: old, received_at: old });
  assert.equal(await paypal.pruneProcessedPaypalWebhookEvidence(), 1);
  const pruned = await inboxRow(paidId);
  assert.deepEqual(pruned.payload, {}, 'name, email and message are gone 30 days after processing');
  assert.deepEqual([pruned.status, pruned.event_type, pruned.resource_id], ['processed', 'Donation', paid.kofi_transaction_id], 'the references stay for replay protection');
  assert.notDeepEqual((await inboxRow(orderId)).payload, {}, 'an unresolved review item keeps its evidence');
  // The emptied row still blocks a replay of the same message, and the receipt is untouched.
  assert.equal((await hook(paid)).status, 200);
  await waitForBackgroundWork(); await kofi.processKofiInbox();
  assert.equal((await inbox()).length, 2);
  assert.equal((await receipts()).length, 1);

  // Once dismissed, the review item follows the same 30-day rule and the list shows no payer data.
  assert.equal((await adminPost(reviewPath(orderId, 'dismiss'), { note: 'Shop order, not lab support' })).status, 200);
  await fixture.db.update(paypalWebhookInbox).set({ processed_at: old }).where(eq(paypalWebhookInbox.id, orderId));
  assert.equal(await paypal.pruneProcessedPaypalWebhookEvidence(), 1);
  const [item] = await reviewItems('resolved');
  assert.deepEqual({ payloadRetained: item.payloadRetained, amount: item.amount, currency: item.currency, fromName: item.fromName, email: item.email,
    message: item.message, tierName: item.tierName, sub: item.isSubscriptionPayment, firstSub: item.isFirstSubscriptionPayment, linkable: item.linkable,
    settleable: item.settleable, matchedUserId: item.matchedUserId, reason: item.reason, kofiTransactionId: item.kofiTransactionId },
  { payloadRetained: false, amount: null, currency: null, fromName: null, email: null, message: null, tierName: null, sub: null, firstSub: null,
    linkable: false, settleable: false, matchedUserId: null, reason: 'UNSUPPORTED_TYPE', kofiTransactionId: order.kofi_transaction_id });
});

test('an unexpected processing error is retried with backoff and ends in review after five attempts', async () => {
  // Stored without the ingress kick, so each pass below is the only worker.
  const event = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00' });
  await kofi.storeKofiWebhook(JSON.stringify(event));
  const id = `live:kofi:${String(event.message_id)}`;
  await db.execute(sql`ALTER TABLE manual_contributions RENAME TO manual_contributions_down`);
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await kofi.processKofiInbox();
      const row = await inboxRow(id);
      assert.equal(row.attempt_count, attempt);
      assert.equal(row.error_code, 'PROCESSING_FAILED');
      if (attempt < 5) {
        assert.equal(row.status, 'pending', `attempt ${attempt} is retried`);
        assert.ok(row.next_attempt_at && row.next_attempt_at.getTime() > Date.now() + 4 * 60_000, 'with a delay');
        // Not due yet: another pass leaves it alone.
        await kofi.processKofiInbox();
        assert.equal((await inboxRow(id)).attempt_count, attempt);
        await fixture.db.update(paypalWebhookInbox).set({ next_attempt_at: null }).where(eq(paypalWebhookInbox.id, id));
      } else {
        assert.deepEqual([row.status, row.next_attempt_at], ['needs_review', null], 'then it is handed to the operator');
      }
    }
  } finally { await db.execute(sql`ALTER TABLE manual_contributions_down RENAME TO manual_contributions`); }
  assert.equal((await receipts()).length, 0, 'a failed attempt records nothing');
  const [item] = await reviewItems();
  assert.deepEqual([item.reason, item.linkable, item.settleable], ['PROCESSING_FAILED', false, false]);
  // Once the cause is fixed, retry sends it through normal processing.
  assert.equal((await adminPost(reviewPath(id, 'retry'))).status, 200);
  await waitForBackgroundWork(); await kofi.processKofiInbox();
  assert.deepEqual([(await inboxRow(id)).status, (await inboxRow(id)).error_code], ['processed', null]);
  assert.equal((await receipts()).length, 1);
});

test('the Ko-fi sample test event is ignored without a review item', async () => {
  const id = await deliver(kofiEvent({ kofi_transaction_id: KOFI_SAMPLE_TRANSACTION_ID, currency: 'USD', amount: '3.00', email: 'someone@example.com' }));
  const row = await inboxRow(id);
  assert.deepEqual([row.status, row.error_code], ['processed', 'TEST_EVENT']);
  assert.deepEqual(await reviewItems('all'), []);
  assert.equal((await receipts()).length, 0);
  const snapshot = await paypal.verifiedContributionSnapshot('live');
  assert.deepEqual([snapshot.reviewEvents, snapshot.unresolvedTransactions, snapshot.eligibleNetOre], [0, 0, 0], 'a test never blocks the budget');
  const status = (await adminGet('/config')).body;
  assert.equal(status.lastEventOutcome, 'ignored_test');
  assert.ok(status.lastTestEventAt);
  assert.equal(status.lastErrorCode === 'TEST_EVENT', false, 'a test is not an error');
  assert.deepEqual(status.counts, { pending: 0, needsReview: 0, awaitingFee: 0, awaitingDkkAmount: 0 });
});

test('disabled integration returns 503 and stores nothing; a storage failure returns 500 and a redelivery then succeeds', async () => {
  const event = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00' });
  const off = await adminPost('/enabled', { enabled: false });
  assert.deepEqual([off.status, off.body.enabled, off.body.configured], [200, false, true]);
  const refused = await hook(event);
  assert.deepEqual([refused.status, refused.text], [503, '']);
  assert.equal((await adminGet('/config')).body.lastErrorCode, 'DISABLED');
  // The token is still checked first: a wrong token learns nothing about the switch.
  assert.equal((await hook(kofiEvent({ verification_token: 'wrong' }))).status, 401);
  await waitForBackgroundWork();
  assert.equal((await inbox()).length, 0);
  assert.equal((await adminPost('/enabled', { enabled: 'yes' })).body.error, 'INVALID_REQUEST');
  assert.equal((await adminPost('/enabled', { enabled: true })).body.enabled, true);

  await db.execute(sql`ALTER TABLE paypal_webhook_inbox RENAME TO paypal_webhook_inbox_down`);
  try {
    const failed = await hook(event);
    assert.deepEqual([failed.status, failed.text], [500, ''], 'not acknowledged, so Ko-fi delivers again');
  } finally { await db.execute(sql`ALTER TABLE paypal_webhook_inbox_down RENAME TO paypal_webhook_inbox`); }
  assert.equal((await inbox()).length, 0);
  await deliver(event);
  assert.equal((await receipts()).length, 1);

  // Enabling needs both a token and a page URL; saving never flips the switch.
  await fixture.db.delete(kofiConfig);
  const unconfigured = await adminPost('/enabled', { enabled: true });
  assert.deepEqual([unconfigured.status, unconfigured.body.error], [409, 'KOFI_NOT_CONFIGURED']);
  assert.equal((await adminPost('/config', { pageUrl: 'https://example.org/homelab' })).body.error, 'INVALID_PAGE_URL');
  assert.equal((await adminPost('/config', { pageUrl: 'https://ko-fi.com/homelab', verificationToken: 'short' })).body.error, 'INVALID_TOKEN_FORMAT');
  const pageOnly = await adminPost('/config', { pageUrl: 'https://www.ko-fi.com/homelab/' });
  assert.deepEqual([pageOnly.status, pageOnly.body.pageUrl, pageOnly.body.tokenStored, pageOnly.body.configured, pageOnly.body.enabled],
    [200, 'https://ko-fi.com/homelab', false, false, false]);
  assert.equal((await adminPost('/enabled', { enabled: true })).body.error, 'KOFI_NOT_CONFIGURED');
  const saved = await adminPost('/config', { pageUrl: 'https://ko-fi.com/homelab', verificationToken: KOFI_TEST_TOKEN });
  assert.deepEqual([saved.body.tokenStored, saved.body.configured, saved.body.enabled, saved.body.webhookUrl, saved.body.webhookUrlError],
    [true, true, false, 'https://portal.example/api/payments/kofi/webhook', null]);
  assert.ok(saved.body.tokenUpdatedAt);
  assert.equal((await adminPost('/enabled', { enabled: true })).body.enabled, true);
  // Saving again without a token keeps the stored one and leaves the integration on.
  const kept = await adminPost('/config', { pageUrl: 'https://ko-fi.com/homelab2' });
  assert.deepEqual([kept.body.tokenStored, kept.body.enabled, kept.body.pageUrl, kept.body.tokenUpdatedAt], [true, true, 'https://ko-fi.com/homelab2', saved.body.tokenUpdatedAt]);
  assert.equal((await hook(kofiEvent({ email: ANDERS_EMAIL }))).status, 200);
});

test('payments status exposes the Ko-fi link only when enabled; payments mine shows only the member\'s own Ko-fi receipts', async () => {
  const status = await request(app).get('/api/payments/status').set('Cookie', anders);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.kofi, { enabled: true, pageUrl: 'https://ko-fi.com/homelab' });
  assert.equal(typeof status.body.checkoutEnabled, 'boolean', 'the PayPal fields are unchanged');
  assert.equal(JSON.stringify(status.body).includes(KOFI_TEST_TOKEN), false);
  await kofi.setKofiEnabled(false, ADMIN);
  assert.deepEqual((await request(app).get('/api/payments/status').set('Cookie', anders)).body.kofi, { enabled: false, pageUrl: null });
  await kofi.setKofiEnabled(true, ADMIN);

  const mine = kofiEvent({ email: ANDERS_EMAIL, amount: '50.00' });
  const theirs = kofiEvent({ email: 'birgit@example.dk', amount: '80.00' });
  const sub = kofiSubscriptionEvent(true, { email: ANDERS_EMAIL, amount: '25.00', timestamp: kofiTimestamp(new Date(Date.now() - 3_600_000)) });
  await kofiAdmin.addKofiMemberEmail({ userId: BIRGIT, email: 'birgit@example.dk' }, ADMIN);
  for (const event of [mine, theirs, sub]) await deliver(event);
  await adminPost(`/receipts/${(await receiptFor(sub)).id}/fee`, { fee: '1.00' });
  const own = (await request(app).get('/api/payments/mine').set('Cookie', anders)).body;
  assert.deepEqual(own.kofiReceipts.map((item: any) => [item.kind, item.amountOre, item.status]), [['donation', 5000, 'awaiting_fee'], ['subscription', 2500, 'counted']]);
  assert.deepEqual(Object.keys(own.kofiReceipts[0]).sort(), ['amountOre', 'kind', 'receivedAt', 'status']);
  assert.ok(Array.isArray(own.postings) && Array.isArray(own.manualReports), 'the existing history fields are unchanged');
  const other = (await request(app).get('/api/payments/mine').set('Cookie', birgit)).body;
  assert.deepEqual(other.kofiReceipts.map((item: any) => [item.amountOre, item.status]), [[8000, 'awaiting_fee']]);
  await adminPost(`/receipts/${(await receiptFor(mine)).id}/reverse`, { reason: 'Recorded by mistake' });
  await adminPost(`/receipts/${(await receiptFor(sub)).id}/reverse`, { reason: 'Refunded by Ko-fi' });
  assert.deepEqual((await request(app).get('/api/payments/mine').set('Cookie', anders)).body.kofiReceipts.map((item: any) => item.status), ['voided', 'reversed']);
});

test('a EUR donation is held as settleable; settle records one posted DKK receipt that keeps the original amount, remembers the email, and cannot be settled twice', async () => {
  const month = allocationMonth(new Date());
  const event = kofiEvent({ email: 'Euro.Friend@example.de', currency: 'EUR', amount: '5.00', from_name: 'Euro Friend' });
  const id = await deliver(event);
  const row = await inboxRow(id);
  assert.deepEqual([row.status, row.error_code], ['needs_review', 'CURRENCY_NOT_DKK']);
  assert.equal((await receipts()).length, 0, 'never recorded or converted automatically');
  let [item] = await reviewItems();
  assert.deepEqual([item.settleable, item.linkable, item.amount, item.currency, item.matchedUserId, item.matchedUsername], [true, false, '5.00', 'EUR', null, null]);
  assert.equal((await adminGet('/config')).body.counts.awaitingDkkAmount, 1);
  assert.equal((await paypal.verifiedContributionSnapshot('live')).eligibleNetOre, null, 'it blocks finalized net like every review item');
  await recalculatePaypalAllocations(month);
  assert.equal((await monthlyEnergyFunding(month)).unresolvedOre, null);
  // A linked email does not make a foreign payment record itself.
  const known = await deliver(kofiEvent({ email: ANDERS_EMAIL, currency: 'USD', amount: '3.00' }));
  assert.equal((await inboxRow(known)).error_code, 'CURRENCY_NOT_DKK');
  assert.equal((await reviewItems()).find((entry) => entry.id === known).matchedUserId, ANDERS);
  assert.equal((await adminPost(reviewPath(known, 'dismiss'), { note: 'Test payment in USD' })).status, 200);

  const settle = (body: unknown, target = id) => adminPost(reviewPath(target, 'settle'), body);
  assert.equal((await adminPost(reviewPath(id, 'link'), { userId: BIRGIT })).body.error, 'REVIEW_EVENT_NOT_LINKABLE');
  assert.equal((await settle({ userId: 'x', grossDkk: '37.25', fee: '1.95' })).body.error, 'INVALID_USER');
  assert.equal((await settle({ grossDkk: '37.25', fee: '1.95' })).body.error, 'INVALID_USER');
  for (const grossDkk of ['37,25', 37.25, '0.99', '10000.01', undefined]) assert.equal((await settle({ userId: BIRGIT, grossDkk, fee: '1.95' })).body.error, 'INVALID_AMOUNT', String(grossDkk));
  assert.equal((await settle({ userId: BIRGIT, grossDkk: '37.25', fee: 'abc' })).body.error, 'INVALID_AMOUNT');
  const feeTooHigh = await settle({ userId: BIRGIT, grossDkk: '37.25', fee: '37.26' });
  assert.deepEqual([feeTooHigh.status, feeTooHigh.body.error], [400, 'FEE_OUT_OF_RANGE']);
  assert.equal((await settle({ userId: BIRGIT, grossDkk: '37.25', fee: '1.95', note: 'x'.repeat(501) })).body.error, 'INVALID_NOTE');
  assert.equal((await settle({ userId: 999, grossDkk: '37.25', fee: '1.95' })).body.error, 'USER_NOT_FOUND');
  assert.equal((await settle({ userId: BIRGIT, grossDkk: '37.25', fee: '1.95' }, 'live:kofi:unknown-message')).status, 404);
  assert.equal((await receipts()).length, 0);
  assert.deepEqual(await postings(), []);

  const settled = await settle({ userId: BIRGIT, grossDkk: '37.25', fee: '1.95', note: 'Stripe payout 9 Nov, line 2' });
  assert.equal(settled.status, 200);
  const receipt = await receiptFor(event);
  assert.deepEqual(settled.body, { status: 'settled', receiptId: receipt.id, grossOre: 3725, feeOre: 195, netOre: 3530 });
  assert.deepEqual({ status: receipt.status, currency: receipt.currency, gross: receipt.gross_ore, fee: receipt.fee_ore, net: receipt.net_ore, user: receipt.user_id,
    originalAmount: receipt.original_amount, originalCurrency: receipt.original_currency, note: receipt.admin_note, kind: receipt.provider_kind },
  { status: 'posted', currency: 'DKK', gross: 3725, fee: 195, net: 3530, user: BIRGIT, originalAmount: '5.00', originalCurrency: 'EUR',
    note: 'Stripe payout 9 Nov, line 2', kind: 'kofi_donation' });
  assert.deepEqual(await postings(), ['kofi:fee:-195', 'kofi:gross:3725'], 'only the DKK amounts the administrator entered are posted');
  assert.ok((await fixture.db.select().from(paypalPostings)).every((entry) => entry.currency === 'DKK' && entry.verification === 'kofi_admin_settlement' && entry.user_id === BIRGIT));
  const resolved = await inboxRow(id);
  assert.deepEqual([resolved.status, resolved.resolution, resolved.resolved_by], ['processed', 'settled', ADMIN]);
  assert.deepEqual((await adminGet('/receipts?status=posted')).body.items.map((entry: any) => [entry.grossOre, entry.feeOre, entry.netOre, entry.originalAmount, entry.originalCurrency, entry.username]),
    [[3725, 195, 3530, '5.00', 'EUR', 'birgit']]);
  assert.deepEqual((await adminGet('/members')).body.items.map((entry: any) => [entry.userId, entry.emailHint, entry.source]).sort(),
    [[ANDERS, 'an…@example.dk', 'admin_entry'], [BIRGIT, 'eu…@example.de', 'admin_link']], 'the email is remembered for the next payment');

  // Settled, so the month is no longer blocked: the budget stops reading Unknown.
  const snapshot = await paypal.verifiedContributionSnapshot('live');
  assert.deepEqual([snapshot.reviewEvents, snapshot.unresolvedTransactions, snapshot.knownNetOre, snapshot.eligibleNetOre], [0, 0, 3530, 3530]);
  const recalculated = await recalculatePaypalAllocations(month);
  assert.notEqual(recalculated.created[0].status, 'unresolved');
  const funding = await monthlyEnergyFunding(month);
  assert.deepEqual([funding.unresolvedOre, funding.grossOre, funding.feeDebitsOre, funding.knownNetOre], [0, 3725, 195, 3530]);
  assert.equal((await adminGet('/config')).body.counts.awaitingDkkAmount, 0);

  const twice = await settle({ userId: BIRGIT, grossDkk: '37.25', fee: '1.95' });
  assert.deepEqual([twice.status, twice.body.error], [404, 'REVIEW_EVENT_NOT_FOUND'], 'an event is settled once');
  // Ko-fi delivers the same transaction again under a new message id: compared on the original amount, not the DKK gross.
  const redelivered = await deliver(kofiEvent({ email: 'euro.friend@example.de', currency: 'EUR', amount: '5.00', kofi_transaction_id: event.kofi_transaction_id }));
  assert.deepEqual([(await inboxRow(redelivered)).status, (await inboxRow(redelivered)).error_code], ['processed', 'DUPLICATE_TRANSACTION']);
  const changed = await deliver(kofiEvent({ email: 'euro.friend@example.de', currency: 'EUR', amount: '6.00', kofi_transaction_id: event.kofi_transaction_id }));
  assert.equal((await inboxRow(changed)).error_code, 'TRANSACTION_CONFLICT');
  const asDkk = await deliver(kofiEvent({ email: 'euro.friend@example.de', currency: 'DKK', amount: '37.25', kofi_transaction_id: event.kofi_transaction_id }));
  assert.equal((await inboxRow(asDkk)).error_code, 'TRANSACTION_CONFLICT', 'the same id in DKK is not the same payment');
  for (const conflict of [changed, asDkk]) assert.equal((await settle({ userId: BIRGIT, grossDkk: '40.00', fee: '1.00' }, conflict)).body.error, 'REVIEW_EVENT_NOT_SETTLEABLE');
  assert.equal((await receipts()).length, 1, 'never a second receipt');
  assert.deepEqual(await postings(), ['kofi:fee:-195', 'kofi:gross:3725'], 'never a second posting');

  // The next EUR payment from the remembered email still needs its DKK amount, but shows the member.
  const nextEvent = kofiSubscriptionEvent(true, { email: 'euro.friend@example.de', currency: 'EUR', amount: '3.00' });
  const nextId = await deliver(nextEvent);
  item = (await reviewItems()).find((entry) => entry.id === nextId);
  assert.deepEqual([item.settleable, item.matchedUserId, item.matchedUsername, item.isFirstSubscriptionPayment, item.tierName], [true, BIRGIT, 'birgit', true, 'Gold']);
  // Remembering that email for a different member is refused; settling without a member works.
  const wrongMember = await settle({ userId: ANDERS, grossDkk: '22.40', fee: '1.20' }, nextId);
  assert.deepEqual([wrongMember.status, wrongMember.body.error], [409, 'EMAIL_ALREADY_LINKED']);
  assert.equal((await receipts()).length, 1);
  const unattributed = await settle({ userId: null, grossDkk: '22.40', fee: '0.00' }, nextId);
  assert.deepEqual([unattributed.status, unattributed.body.grossOre, unattributed.body.netOre], [200, 2240, 2240]);
  assert.deepEqual([(await receiptFor(nextEvent)).user_id, (await receiptFor(nextEvent)).provider_kind], [null, 'kofi_subscription']);
  // A settled receipt is reversed like any posted receipt.
  assert.deepEqual((await adminPost(`/receipts/${receipt.id}/reverse`, { reason: 'Chargeback', feeCredit: '0.00' })).body, { id: receipt.id, status: 'reversed' });
  assert.deepEqual(await postings(), ['kofi:fee:-195', 'kofi:fee:0', 'kofi:fee_credit:0', 'kofi:gross:2240', 'kofi:gross:3725', 'kofi:reversal:-3725']);
});
