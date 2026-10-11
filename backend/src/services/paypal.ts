import { randomUUID } from 'node:crypto';
import { and, eq, desc, lt, gt, or, isNull, lte, notInArray, inArray, sql, count } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalConfigs, paypalConfigHistory, paypalIntents, paypalSubscriptions, paypalWebhookInbox, paypalTransactions, paypalReconciliation, paypalPostings } from '../db/schema/index.ts';
import { encryptSecret, decryptSecret } from '../utils/secrets.ts';
import { log } from '../utils/logger.ts';
import { incrementMetric } from '../utils/metricRegistry.ts';
import { PayPalError, paypalClient, type PayPalEnvironment, type PayPalCredentials } from './paypalClient.ts';
import { normalizeCompletedCapture, normalizeSubscriptionTransaction, normalizeCaptureRefund, normalizeReportedAdjustment, oreToDkk, parseDkkOre } from './paypalMoney.ts';
import { postReceipt, postCaptureRefund, postProviderAdjustment } from './paypalLedger.ts';
import { PAYMENT_STATE_EVENTS, closePendingState, openPaymentStateTotals, recordPaymentStateEvent } from './paypalPaymentStates.ts';
import { isAdjustedSaleStatus, linkedCaptureId, settleCaptureAdjustments, settleSaleAdjustments } from './paypalCoverage.ts';

function environment(value: unknown): PayPalEnvironment {
  if (value !== 'sandbox' && value !== 'live') throw new PayPalError('INVALID_ENVIRONMENT', 400);
  return value;
}
function checkoutReturnUrls(kind: 'one_off' | 'monthly') {
  const configured = process.env.PORTAL_BASE_URL || process.env.ALLOWED_ORIGIN;
  let base: URL;
  try { base = new URL(configured || ''); } catch { throw new PayPalError('RETURN_ORIGIN_NOT_CONFIGURED', 409); }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      (process.env.ALLOWED_ORIGIN && base.origin !== process.env.ALLOWED_ORIGIN))
    throw new PayPalError('RETURN_ORIGIN_INVALID', 409);
  const path = kind === 'monthly' ? '/support?paypal=monthly' : '/support?paypal=one-off';
  return { returnUrl: `${base.origin}${path}`, cancelUrl: `${base.origin}/support?paypal=cancelled` };
}
async function configured(value: unknown) {
  const env = environment(value);
  const [row] = await db.select().from(paypalConfigs).where(eq(paypalConfigs.environment, env)).limit(1);
  if (!row?.client_id || !row.client_secret || !row.merchant_id || !row.webhook_id) throw new PayPalError('NOT_CONFIGURED', 409);
  return row;
}
function credentials(row: Awaited<ReturnType<typeof configured>>): PayPalCredentials {
  return { environment: environment(row.environment), clientId: row.client_id!, clientSecret: decryptSecret(row.client_secret!)!, version: row.config_version };
}
export function paypalApprovalUrl(value: unknown, env: PayPalEnvironment) {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new PayPalError('APPROVAL_URL_INVALID'); }
  const host = env === 'sandbox' ? 'www.sandbox.paypal.com' : 'www.paypal.com';
  if (url.protocol !== 'https:' || url.host !== host || url.username || url.password)
    throw new PayPalError('APPROVAL_URL_INVALID');
  return url.href;
}
export async function paypalSetupStatus() {
  const rows = await db.select().from(paypalConfigs);
  return rows.map((row) => ({ environment: row.environment, configured: Boolean(row.client_id && row.client_secret && row.merchant_id && row.webhook_id),
    enabled: row.enabled, merchantId: row.merchant_id, clientId: row.client_id, webhookId: row.webhook_id, secretStored: Boolean(row.client_secret),
    monthlyPlanId: row.monthly_plan_id, monthlyAmountOre: row.monthly_amount_ore, configVersion: row.config_version }));
}
export function validateMonthlyPlan(plan: any, amountOre: number) {
  const cycle = plan?.billing_cycles?.filter((item: any) => item.tenure_type === 'REGULAR');
  if (plan?.status !== 'ACTIVE' || !Array.isArray(cycle) || cycle.length !== 1 || plan.billing_cycles.length !== 1 ||
      cycle[0].frequency?.interval_unit !== 'MONTH' || cycle[0].frequency?.interval_count !== 1 ||
      cycle[0].pricing_scheme?.fixed_price?.currency_code !== 'DKK' ||
      cycle[0].pricing_scheme?.fixed_price?.value !== oreToDkk(amountOre) ||
      plan.payment_preferences?.auto_bill_outstanding !== false || plan.payment_preferences?.setup_fee)
    throw new PayPalError('UNSAFE_MONTHLY_PLAN', 409);
}
type ConfigRow = typeof paypalConfigs.$inferSelect;
function historyRow(row: ConfigRow, action: string, actorId: number | null, secretChanged = false) {
  return { environment: row.environment, config_version: row.config_version, action, actor_user_id: actorId, client_id: row.client_id,
    merchant_id: row.merchant_id, webhook_id: row.webhook_id, monthly_plan_id: row.monthly_plan_id, monthly_amount_ore: row.monthly_amount_ore,
    enabled: row.enabled, secret_changed: secretChanged };
}
/** Credentials for setup actions, which may run before a webhook ID exists. */
export async function paypalSetupCredentials(value: unknown) {
  const env = environment(value);
  const [row] = await db.select().from(paypalConfigs).where(eq(paypalConfigs.environment, env)).limit(1);
  if (!row?.client_id || !row.client_secret || !row.merchant_id) throw new PayPalError('NOT_CONFIGURED', 409);
  return { row, config: credentials(row as Awaited<ReturnType<typeof configured>>) };
}
/**
 * Versioned, compare-and-set configuration save. `expectedVersion` (when
 * given) must match the stored version, so a stale form or an old request
 * cannot overwrite a newer configuration. The secret is write-only: omitting
 * it keeps the stored one, but only while the client ID is unchanged.
 * Saving always disables checkout until it is explicitly re-enabled.
 */
export async function savePaypalConfiguration(input: any, actorId: number | null = null) {
  const env = environment(input.environment);
  const clientId = String(input.clientId || ''); const secret = String(input.clientSecret || '');
  const merchant = String(input.merchantId || ''); const webhook = input.webhookId ? String(input.webhookId) : null;
  const plan = input.monthlyPlanId == null || input.monthlyPlanId === '' ? null : String(input.monthlyPlanId);
  const monthlyOre = input.monthlyAmount == null || input.monthlyAmount === '' ? null : parseDkkOre(input.monthlyAmount);
  const expected = input.expectedVersion === undefined ? undefined : input.expectedVersion;
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(clientId) || secret.length > 1024 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(merchant) || (webhook !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(webhook)) ||
      (plan !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(plan)) || Boolean(plan) !== Boolean(monthlyOre) ||
      (expected !== undefined && expected !== null && !Number.isInteger(expected))) throw new PayPalError('INVALID_CONFIG', 400);
  await db.transaction(async (tx) => {
    const [old] = await tx.select().from(paypalConfigs).where(eq(paypalConfigs.environment, env)).for('update');
    if (expected !== undefined && (old ? expected !== old.config_version : expected !== null && expected !== 0))
      throw new PayPalError('CONFIG_VERSION_CONFLICT', 409);
    if (!secret && (!old?.client_secret || old.client_id !== clientId)) throw new PayPalError('INVALID_CONFIG', 400);
    if (old?.merchant_id && old.merchant_id !== merchant) {
      const [active] = await tx.select({ id: paypalSubscriptions.id }).from(paypalSubscriptions)
        .where(and(eq(paypalSubscriptions.environment, env), eq(paypalSubscriptions.merchant_id, old.merchant_id), notInArray(paypalSubscriptions.status, ['CANCELLED', 'EXPIRED']))).limit(1);
      if (active) throw new PayPalError('ACTIVE_SUBSCRIPTIONS', 409);
    }
    const values = { client_id: clientId, client_secret: secret ? encryptSecret(secret) : old!.client_secret, merchant_id: merchant,
      webhook_id: webhook, monthly_plan_id: plan, monthly_amount_ore: monthlyOre, enabled: false,
      config_version: (old?.config_version ?? 0) + 1, updated_at: new Date() };
    let saved: ConfigRow | undefined;
    if (old) [saved] = await tx.update(paypalConfigs).set(values)
      .where(and(eq(paypalConfigs.environment, env), eq(paypalConfigs.config_version, old.config_version))).returning();
    else [saved] = await tx.insert(paypalConfigs).values({ environment: env, ...values }).onConflictDoNothing().returning();
    if (!saved) throw new PayPalError('CONFIG_VERSION_CONFLICT', 409);
    await tx.insert(paypalConfigHistory).values(historyRow(saved, 'save', actorId, Boolean(secret)));
  });
  paypalClient.invalidate();
}
export async function setPaypalEnabled(value: unknown, enabled: boolean, actorId: number | null = null, expectedVersion?: number) {
  const row = await configured(value);
  if (expectedVersion !== undefined && expectedVersion !== row.config_version) throw new PayPalError('CONFIG_VERSION_CONFLICT', 409);
  if (enabled && row.monthly_plan_id) validateMonthlyPlan(await paypalClient.getPlan(credentials(row), row.monthly_plan_id), row.monthly_amount_ore!);
  await db.transaction(async (tx) => {
    const [saved] = await tx.update(paypalConfigs).set({ enabled, config_version: row.config_version + 1, updated_at: new Date() })
      .where(and(eq(paypalConfigs.environment, row.environment), eq(paypalConfigs.config_version, row.config_version))).returning();
    if (!saved) throw new PayPalError('CONFIG_VERSION_CONFLICT', 409);
    await tx.insert(paypalConfigHistory).values(historyRow(saved, enabled ? 'enable' : 'disable', actorId));
  });
  paypalClient.invalidate();
}
// Durable per-member checkout limit: counting and inserting happen under a
// per-user advisory lock so concurrent clicks cannot exceed it.
export const CHECKOUT_INTENTS_PER_HOUR = 10;
async function insertRateLimitedIntent(userId: number, values: typeof paypalIntents.$inferInsert) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(238100, ${userId})`);
    const [{ recent }] = await tx.select({ recent: count() }).from(paypalIntents)
      .where(and(eq(paypalIntents.user_id, userId), gt(paypalIntents.created_at, new Date(Date.now() - 60 * 60_000))));
    if (recent >= CHECKOUT_INTENTS_PER_HOUR) throw new PayPalError('CHECKOUT_RATE_LIMIT', 429);
    await tx.insert(paypalIntents).values(values);
  });
}
export async function createOneOff(userId: number, amount: string, value: unknown) {
  const row = await configured(value);
  if (!row.enabled) throw new PayPalError('CHECKOUT_DISABLED', 409);
  const amountOre = parseDkkOre(amount);
  const id = randomUUID(); const requestId = randomUUID();
  await insertRateLimitedIntent(userId, { id, user_id: userId, environment: row.environment, merchant_id: row.merchant_id!, kind: 'one_off',
    amount_ore: amountOre, create_request_id: requestId, config_version: row.config_version });
  const { returnUrl, cancelUrl } = checkoutReturnUrls('one_off');
  const order = await paypalClient.createOrder(credentials(row), oreToDkk(amountOre), id, requestId, returnUrl, cancelUrl);
  if (typeof order.id !== 'string' || !['CREATED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) throw new PayPalError('ORDER_CREATE_UNKNOWN');
  await db.update(paypalIntents).set({ provider_id: order.id, status: 'approval_pending', updated_at: new Date() }).where(eq(paypalIntents.id, id));
  const approval = Array.isArray(order.links) ? order.links.find((link: any) => link.rel === 'approve' || link.rel === 'payer-action')?.href : null;
  return { intentId: id, approvalUrl: paypalApprovalUrl(approval, row.environment as PayPalEnvironment), status: 'approval_pending' };
}
export async function captureOneOff(userId: number, intentId: string) {
  const [intent] = await db.select().from(paypalIntents).where(and(eq(paypalIntents.id, intentId), eq(paypalIntents.user_id, userId))).limit(1);
  if (!intent || intent.kind !== 'one_off' || !intent.provider_id) throw new PayPalError('INTENT_NOT_FOUND', 404);
  if (intent.status === 'verified') return { status: 'verified' };
  if (intent.status === 'capture_failed' || intent.status === 'expired') return { status: 'failed' };
  const row = await configured(intent.environment);
  if (row.merchant_id !== intent.merchant_id || row.config_version !== intent.config_version) throw new PayPalError('CONFIG_CHANGED', 409);
  const config = credentials(row);
  const order = await paypalClient.getOrder(config, intent.provider_id);
  const unit = Array.isArray(order.purchase_units) && order.purchase_units.length === 1 ? order.purchase_units[0] : null;
  if (order.id !== intent.provider_id || !['APPROVED', 'COMPLETED'].includes(order.status) || unit?.custom_id !== intent.id ||
      unit?.payee?.merchant_id !== intent.merchant_id || unit?.amount?.currency_code !== 'DKK' ||
      unit?.amount?.value !== oreToDkk(intent.amount_ore)) throw new PayPalError('ORDER_MISMATCH', 409);
  if (intent.status !== 'approval_pending' || order.status === 'COMPLETED') {
    // Already captured (by an earlier request, reconciliation or a webhook):
    // ingest the provider's capture rather than capturing again.
    const captures = unit?.payments?.captures;
    if (Array.isArray(captures) && captures.length === 1 && COMPLETED_CAPTURE_STATUSES.includes(captures[0]?.status) &&
        typeof captures[0].id === 'string') return ingestOneOffCapture(config, intent, captures[0].id, 'member_readback');
    if (intent.status === 'approval_pending') throw new PayPalError('ORDER_MISMATCH', 409);
    // A previous POST may still be in flight or its outcome may not yet be visible.
    // Never issue another capture from a member retry; reconciliation will read it back.
    return { status: 'pending_verification' };
  }
  if (order.status !== 'APPROVED') throw new PayPalError('ORDER_MISMATCH', 409);
  const requestId = intent.capture_request_id || randomUUID();
  const claim = await db.update(paypalIntents).set({ status: 'capturing', capture_request_id: requestId, updated_at: new Date() })
    .where(and(eq(paypalIntents.id, intentId), eq(paypalIntents.status, 'approval_pending')));
  if (claim.rowCount !== 1) throw new PayPalError('CAPTURE_ALREADY_STARTED', 409);
  let result: any;
  try { result = await paypalClient.captureOrder(config, intent.provider_id, requestId); }
  catch (err) { await db.update(paypalIntents).set({ status: 'capture_unknown' }).where(eq(paypalIntents.id, intentId)); throw err; }
  const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture?.status === 'COMPLETED') {
    await ingestOneOffCapture(config, intent, capture.id, 'api_capture');
    return { status: 'verified' };
  }
  await db.update(paypalIntents).set({ status: 'capture_unknown' }).where(eq(paypalIntents.id, intentId));
  return { status: 'pending_verification' };
}
export async function ingestOneOffCapture(config: PayPalCredentials, intent: typeof paypalIntents.$inferSelect, captureId: string, verification: string) {
  const detail = await paypalClient.getCapture(config, captureId);
  const result = await postOneOffCaptureDetail(intent, detail, verification);
  // A capture already reported as refunded/reversed must not stand as plain
  // income: record its adjustments (or keep it unresolved) before finalizing.
  const adjustment = await settleCaptureAdjustments(config, intent, detail, verification);
  const status = result.status === 'posted' && adjustment.status !== 'unresolved' ? 'verified' : 'net_unresolved';
  await db.update(paypalIntents).set({ status, updated_at: new Date() }).where(eq(paypalIntents.id, intent.id));
  return { status };
}
async function postOneOffCaptureDetail(intent: typeof paypalIntents.$inferSelect, detail: any, verification: string) {
  const normalized = normalizeCompletedCapture(detail, { orderId: intent.provider_id!, merchantId: intent.merchant_id, amountOre: intent.amount_ore });
  return postReceipt({ environment: intent.environment, merchantId: intent.merchant_id, intentId: intent.id, userId: intent.user_id },
    'capture', normalized, verification);
}
export async function storeVerifiedWebhook(value: unknown, headers: Record<string, string | string[] | undefined>, raw: Buffer) {
  const row = await configured(value);
  if (raw.byteLength > 128 * 1024) throw new PayPalError('OVERSIZED', 413);
  let event: any;
  try { event = JSON.parse(raw.toString('utf8')); } catch { throw new PayPalError('MALFORMED', 400); }
  if (!event || typeof event.id !== 'string' || typeof event.event_type !== 'string' || !event.resource || typeof event.resource !== 'object') throw new PayPalError('MALFORMED', 400);
  const verified = await paypalClient.verifyWebhook(credentials(row), row.webhook_id!, headers, raw);
  if (!verified) throw new PayPalError('SIGNATURE_INVALID', 401);
  await db.insert(paypalWebhookInbox).values({ id: `${row.environment}:${row.merchant_id}:${event.id}`, environment: row.environment,
    merchant_id: row.merchant_id!, event_type: event.event_type, resource_id: String(event.resource.id || ''), payload: event,
    event_at: event.create_time ? new Date(event.create_time) : null }).onConflictDoNothing();
  return { acknowledged: true };
}
const MAX_PROVIDER_PAGES = 20;
const EVENT_PAGE_PARAMS = ['page_size', 'start_time', 'end_time', 'page', 'next_page_token', 'event_type', 'transaction_id'];
const TRANSACTION_PAGE_PARAMS = ['start_time', 'end_time', 'page', 'page_size', 'next_page_token'];
function nextLink(page: any): string | null {
  const link = Array.isArray(page?.links) ? page.links.find((item: any) => item?.rel === 'next') : null;
  return typeof link?.href === 'string' ? link.href : null;
}
/**
 * All transactions of one subscription in [from, to]. Follows validated
 * `next` links; if PayPal reports more pages without a link, the window is
 * split in half (bounded depth) and results are de-duplicated by ID.
 */
export async function listAllSubscriptionTransactions(config: PayPalCredentials, id: string, from: Date, to: Date, depth = 0): Promise<any[]> {
  const path = `/v1/billing/subscriptions/${id}/transactions`;
  let page = await paypalClient.listSubscriptionTransactions(config, id, from, to);
  const items: any[] = [];
  for (let pageNumber = 0; ; pageNumber++) {
    if (!Array.isArray(page?.transactions) || page.transactions.length > 200) throw new PayPalError('TRANSACTIONS_INCOMPLETE', 409);
    items.push(...page.transactions);
    const next = nextLink(page);
    if (next) {
      if (pageNumber >= MAX_PROVIDER_PAGES - 1) throw new PayPalError('TRANSACTIONS_INCOMPLETE', 409);
      page = await paypalClient.followNext(config, next, path, TRANSACTION_PAGE_PARAMS);
      continue;
    }
    if (Number(page.total_pages || 1) > pageNumber + 1) {
      if (depth >= 4 || to.getTime() - from.getTime() < 2 * 60 * 60_000) throw new PayPalError('TRANSACTIONS_INCOMPLETE', 409);
      const middle = new Date(from.getTime() + Math.floor((to.getTime() - from.getTime()) / 2));
      const halves = [...await listAllSubscriptionTransactions(config, id, from, middle, depth + 1),
        ...await listAllSubscriptionTransactions(config, id, middle, to, depth + 1)];
      return [...new Map(halves.map((item) => [item?.id, item])).values()];
    }
    break;
  }
  return [...new Map(items.map((item) => [item?.id, item])).values()];
}
// The OAuth-authenticated, app-scoped event list recovers deliveries lost during an
// outage. Events still pass the normal local intent/merchant linkage checks.
export async function recoverPaypalEvents(row: Awaited<ReturnType<typeof configured>>, now: Date, cursor: Date | null) {
  const from = new Date(Math.max(now.getTime() - 30 * 86_400_000,
    (cursor?.getTime() ?? now.getTime() - 30 * 86_400_000) - 24 * 60 * 60_000));
  const to = new Date(Math.min(now.getTime(), from.getTime() + 7 * 86_400_000));
  if (to <= from) return { through: now, stored: 0 };
  const config = credentials(row);
  let page = await paypalClient.listWebhookEvents(config, from, to);
  let stored = 0;
  for (let pageNumber = 0; ; pageNumber++) {
    if (!Array.isArray(page?.events) || page.events.length > 100) throw new PayPalError('EVENTS_INCOMPLETE', 409);
    for (const event of page.events) {
      if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id) ||
          typeof event.event_type !== 'string' || typeof event.resource !== 'object' || !event.resource)
        throw new PayPalError('EVENT_MALFORMED', 409);
      const result = await db.insert(paypalWebhookInbox).values({ id: `${row.environment}:${row.merchant_id}:${event.id}`,
        environment: row.environment, merchant_id: row.merchant_id!, event_type: event.event_type,
        resource_id: String(event.resource.id || ''), payload: event, source: 'provider_readback',
        event_at: event.create_time ? limitedTime(event.create_time) : null }).onConflictDoNothing();
      stored += result.rowCount ?? 0;
    }
    const next = nextLink(page);
    if (!next) break;
    // Bounded: a window that needs more pages fails visibly and keeps the cursor.
    if (pageNumber >= MAX_PROVIDER_PAGES - 1) throw new PayPalError('EVENTS_INCOMPLETE', 409);
    page = await paypalClient.followNext(config, next, '/v1/notifications/webhooks-events', EVENT_PAGE_PARAMS);
  }
  return { through: to, stored };
}
export async function ownPaymentHistory(userId: number) {
  const intents = await db.select({ id: paypalIntents.id, kind: paypalIntents.kind, status: paypalIntents.status,
    amountOre: paypalIntents.amount_ore, createdAt: paypalIntents.created_at, environment: paypalIntents.environment })
    .from(paypalIntents).where(eq(paypalIntents.user_id, userId)).orderBy(desc(paypalIntents.created_at)).limit(100);
  const postings = await db.select({ postingKind: paypalPostings.posting_kind, amountOre: paypalPostings.amount_ore,
    effectiveAt: paypalPostings.effective_at, environment: paypalPostings.environment })
    .from(paypalPostings).where(eq(paypalPostings.user_id, userId)).orderBy(desc(paypalPostings.effective_at)).limit(100);
  const subscriptions = await db.select({ id: paypalSubscriptions.id, status: paypalSubscriptions.status,
    amountOre: paypalSubscriptions.amount_ore, environment: paypalSubscriptions.environment,
    nextBillingAt: paypalSubscriptions.next_billing_at, cancellationRequestedAt: paypalSubscriptions.cancellation_requested_at })
    .from(paypalSubscriptions).where(eq(paypalSubscriptions.user_id, userId)).orderBy(desc(paypalSubscriptions.updated_at)).limit(50);
  return { items: intents, postings, subscriptions };
}
export async function memberPaypalStatus() {
  const [row] = await db.select({ enabled: paypalConfigs.enabled, monthly_plan_id: paypalConfigs.monthly_plan_id,
    monthly_amount_ore: paypalConfigs.monthly_amount_ore, client_id: paypalConfigs.client_id,
    client_secret: paypalConfigs.client_secret, merchant_id: paypalConfigs.merchant_id, webhook_id: paypalConfigs.webhook_id })
    .from(paypalConfigs).where(eq(paypalConfigs.environment, 'live')).limit(1);
  return { environment: 'live', configured: Boolean(row?.client_id && row.client_secret && row.merchant_id && row.webhook_id),
    checkoutEnabled: row?.enabled === true, monthlyAvailable: row?.enabled === true && Boolean(row.monthly_plan_id && row.monthly_amount_ore),
    monthlyAmountOre: row?.enabled === true ? row.monthly_amount_ore : null };
}

export async function processPaypalInbox(limit = 20) {
  await db.update(paypalWebhookInbox).set({ status: 'pending', processing_at: null })
    .where(and(eq(paypalWebhookInbox.status, 'processing'), lt(paypalWebhookInbox.processing_at, new Date(Date.now() - 10 * 60_000))));
  const pending = await db.select().from(paypalWebhookInbox).where(and(eq(paypalWebhookInbox.status, 'pending'),
    or(isNull(paypalWebhookInbox.next_attempt_at), lte(paypalWebhookInbox.next_attempt_at, new Date()))))
    .orderBy(paypalWebhookInbox.received_at).limit(Math.max(1, Math.min(limit, 50)));
  for (const entry of pending) {
    const claim = await db.update(paypalWebhookInbox).set({ status: 'processing', processing_at: new Date(),
      attempt_count: entry.attempt_count + 1 })
      .where(and(eq(paypalWebhookInbox.id, entry.id), eq(paypalWebhookInbox.status, 'pending')));
    if (claim.rowCount !== 1) continue;
    let outcome = 'processed';
    try {
      const event = entry.payload as any;
      const resource = event.resource;
      if (entry.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        const orderId = resource?.supplementary_data?.related_ids?.order_id;
        if (!orderId || resource?.payee?.merchant_id !== entry.merchant_id) throw new PayPalError('UNLINKED_CAPTURE', 409);
        const [intent] = await db.select().from(paypalIntents).where(and(eq(paypalIntents.environment, entry.environment),
          eq(paypalIntents.merchant_id, entry.merchant_id), eq(paypalIntents.provider_id, orderId))).limit(1);
        if (!intent || intent.kind !== 'one_off') throw new PayPalError('UNLINKED_CAPTURE', 409);
        const row = await configured(entry.environment);
        if (row.merchant_id !== entry.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
        await ingestOneOffCapture(credentials(row), intent, resource.id, entry.source);
        await closePendingState(entry.environment, entry.merchant_id, resource.id);
      } else if (PAYMENT_STATE_EVENTS.has(entry.event_type)) {
        // Pending/denied/dispute: tracked, never posted or subtracted.
        outcome = (await recordPaymentStateEvent(entry, resource)) === 'recorded' ? 'tracked' : 'unlinked';
      } else if (entry.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
        const row = await configured(entry.environment);
        if (row.merchant_id !== entry.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
        await ingestCaptureRefund(credentials(row), resource.id, entry.source);
      } else if (entry.event_type === 'PAYMENT.SALE.COMPLETED') {
        const subscriptionId = resource?.billing_agreement_id || resource?.subscription_id;
        const [sub] = await db.select().from(paypalSubscriptions).where(and(eq(paypalSubscriptions.id, subscriptionId),
          eq(paypalSubscriptions.environment, entry.environment), eq(paypalSubscriptions.merchant_id, entry.merchant_id))).limit(1);
        if (!sub) throw new PayPalError('UNLINKED_SALE', 409);
        const center = limitedTime(event.create_time);
        await reconcileSubscription(sub, new Date(center.getTime() - 2 * 86_400_000),
          new Date(center.getTime() + 86_400_000), resource.id);
        await closePendingState(entry.environment, entry.merchant_id, resource.id);
      } else if (entry.event_type.startsWith('BILLING.SUBSCRIPTION.')) {
        const [sub] = await db.select().from(paypalSubscriptions).where(and(eq(paypalSubscriptions.id, resource.id),
          eq(paypalSubscriptions.environment, entry.environment), eq(paypalSubscriptions.merchant_id, entry.merchant_id))).limit(1);
        if (!sub) throw new PayPalError('UNLINKED_SUBSCRIPTION', 409);
        const center = limitedTime(event.create_time);
        await reconcileSubscription(sub, new Date(center.getTime() - 2 * 86_400_000), new Date(center.getTime() + 86_400_000));
      } else if (['PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED', 'PAYMENT.CAPTURE.REVERSED'].includes(entry.event_type)) {
        const row = await configured(entry.environment);
        if (row.merchant_id !== entry.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
        await ingestReportedAdjustment(credentials(row), resource.id, entry.event_type, limitedTime(event.create_time), entry.source);
      } else {
        // Pending/denied/dispute/unknown events are evidence, never income.
        outcome = 'not_posted';
      }
      recordInboxOutcome(entry.environment, entry.event_type, outcome);
      await db.update(paypalWebhookInbox).set({ status: 'processed', processed_at: new Date(), error_code: null })
        .where(eq(paypalWebhookInbox.id, entry.id));
    } catch (err) {
      const code = err instanceof PayPalError ? err.code : 'PROCESSING_FAILED';
      recordInboxOutcome(entry.environment, entry.event_type, code.startsWith('UNLINKED_') ? 'unlinked' : 'failed', code);
      const retryable = ['ADJUSTMENT_NOT_READY', 'UNLINKED_ADJUSTMENT', 'UNLINKED_CAPTURE', 'UNLINKED_SALE', 'UNLINKED_REFUND', 'ORIGINAL_RECEIPT_MISSING',
        'HTTP_429', 'HTTP_503', 'NETWORK'].includes(code);
      const retry = retryable && entry.attempt_count < 10;
      await db.update(paypalWebhookInbox).set({ status: retry ? 'pending' : 'needs_review', error_code: code,
        processing_at: null, next_attempt_at: retry ? new Date(Date.now() + paypalInboxRetryDelayMs(entry.attempt_count + 1)) : null })
        .where(eq(paypalWebhookInbox.id, entry.id));
    }
  }
  await pruneProcessedPaypalWebhookEvidence();
}
// Keep economic postings and inbox IDs for replay protection while discarding
// old provider payloads, which can contain payer data. Review/pending events
// retain their evidence until an operator has resolved them.
// Observability for inbox outcomes. Labels use a fixed vocabulary: the event
// type is reduced to a known name or OTHER, and no IDs, amounts or payer data
// ever reach logs or metric labels.
const KNOWN_EVENT_TYPES = new Set(['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.PENDING', 'PAYMENT.SALE.DENIED',
  'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED', 'CHECKOUT.ORDER.APPROVED', 'CHECKOUT.ORDER.COMPLETED',
  'BILLING.SUBSCRIPTION.CREATED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED', 'RISK.DISPUTE.CREATED']);
export function paypalEventLabel(eventType: unknown) {
  return typeof eventType === 'string' && KNOWN_EVENT_TYPES.has(eventType) ? eventType : 'OTHER';
}
function recordInboxOutcome(environment: string, eventType: string, outcome: string, code?: string) {
  const type = paypalEventLabel(eventType);
  const env = environment === 'live' ? 'live' : 'sandbox';
  incrementMetric('paypal_webhook_events', `environment="${env}",type="${type}",outcome="${outcome}"`);
  if (outcome === 'processed') return;
  const dispute = type.includes('DISPUTE');
  log(outcome === 'failed' || outcome === 'unlinked' ? 'warn' : 'info', 'paypal_webhook_event_not_posted', {
    environment: env, type, outcome, ...(dispute ? { dispute: true } : {}),
    ...(code ? { code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'OTHER' } : {}) });
}
export async function pruneProcessedPaypalWebhookEvidence(now = new Date(), limit = 50) {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  if (!Number.isFinite(cutoff.getTime())) throw new PayPalError('INVALID_TIME', 400);
  const ids = await db.select({ id: paypalWebhookInbox.id }).from(paypalWebhookInbox)
    .where(and(inArray(paypalWebhookInbox.status, ['processed', 'dismissed']), lt(paypalWebhookInbox.processed_at, cutoff),
      sql`${paypalWebhookInbox.payload} <> '{}'::jsonb`))
    .orderBy(paypalWebhookInbox.processed_at).limit(Math.max(1, Math.min(limit, 50)));
  if (!ids.length) return 0;
  await db.update(paypalWebhookInbox).set({ payload: {} })
    .where(and(inArray(paypalWebhookInbox.status, ['processed', 'dismissed']), inArray(paypalWebhookInbox.id, ids.map((row) => row.id))));
  return ids.length;
}
export function paypalInboxRetryDelayMs(attempt: number) {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, Math.min(attempt - 1, 10)));
}

export async function createMonthly(userId: number, value: unknown) {
  const row = await configured(value);
  if (!row.enabled || !row.monthly_plan_id || !row.monthly_amount_ore) throw new PayPalError('MONTHLY_DISABLED', 409);
  const id = randomUUID(); const requestId = randomUUID();
  await insertRateLimitedIntent(userId, { id, user_id: userId, environment: row.environment, merchant_id: row.merchant_id!, kind: 'monthly',
    amount_ore: row.monthly_amount_ore, create_request_id: requestId, config_version: row.config_version });
  const { returnUrl, cancelUrl } = checkoutReturnUrls('monthly');
  const result = await paypalClient.createSubscription(credentials(row), row.monthly_plan_id, id, requestId, returnUrl, cancelUrl);
  if (typeof result.id !== 'string' || result.status !== 'APPROVAL_PENDING') throw new PayPalError('SUBSCRIPTION_CREATE_UNKNOWN');
  await db.transaction(async (tx) => {
    await tx.update(paypalIntents).set({ provider_id: result.id, status: 'approval_pending', updated_at: new Date() }).where(eq(paypalIntents.id, id));
    await tx.insert(paypalSubscriptions).values({ id: result.id, intent_id: id, user_id: userId, environment: row.environment,
      merchant_id: row.merchant_id!, status: 'APPROVAL_PENDING', plan_id: row.monthly_plan_id!, amount_ore: row.monthly_amount_ore! });
  });
  const approval = Array.isArray(result.links) ? result.links.find((link: any) => link.rel === 'approve')?.href : null;
  return { intentId: id, subscriptionId: result.id, approvalUrl: paypalApprovalUrl(approval, row.environment as PayPalEnvironment), status: 'approval_pending' };
}
export async function cancelMonthly(userId: number, id: string) {
  const [subscription] = await db.select().from(paypalSubscriptions).where(and(eq(paypalSubscriptions.id, id), eq(paypalSubscriptions.user_id, userId))).limit(1);
  if (!subscription) throw new PayPalError('SUBSCRIPTION_NOT_FOUND', 404);
  return cancelSubscriptionRecord(subscription);
}

export async function adminPaypalSubscriptions(value: unknown, offset = 0) {
  const env = environment(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new PayPalError('INVALID_OFFSET', 400);
  const rows = await db.select({ id: paypalSubscriptions.id, userId: paypalSubscriptions.user_id,
    status: paypalSubscriptions.status, amountOre: paypalSubscriptions.amount_ore,
    nextBillingAt: paypalSubscriptions.next_billing_at, cancellationRequestedAt: paypalSubscriptions.cancellation_requested_at,
    reconcileErrorCode: paypalSubscriptions.reconcile_error_code, updatedAt: paypalSubscriptions.updated_at })
    .from(paypalSubscriptions).where(eq(paypalSubscriptions.environment, env))
    .orderBy(sql`CASE WHEN ${paypalSubscriptions.status} IN ('CANCELLED', 'EXPIRED') THEN 1 ELSE 0 END`,
      desc(paypalSubscriptions.updated_at), desc(paypalSubscriptions.id))
    .limit(101).offset(offset);
  return { environment: env, items: rows.slice(0, 100), nextOffset: rows.length > 100 ? offset + 100 : null };
}

export async function adminCancelMonthly(value: unknown, id: string) {
  const env = environment(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new PayPalError('INVALID_ID', 400);
  const [subscription] = await db.select().from(paypalSubscriptions)
    .where(and(eq(paypalSubscriptions.environment, env), eq(paypalSubscriptions.id, id))).limit(1);
  if (!subscription) throw new PayPalError('SUBSCRIPTION_NOT_FOUND', 404);
  return cancelSubscriptionRecord(subscription);
}

export function isTerminalSubscriptionStatus(status: string) {
  return status === 'CANCELLED' || status === 'EXPIRED';
}
export function assertSubscriptionIdentity(detail: any, subscription: Pick<typeof paypalSubscriptions.$inferSelect, 'id' | 'plan_id' | 'intent_id'>) {
  if (detail?.id !== subscription.id || detail?.plan_id !== subscription.plan_id || detail?.custom_id !== subscription.intent_id)
    throw new PayPalError('SUBSCRIPTION_MISMATCH', 409);
}

async function cancelSubscriptionRecord(subscription: typeof paypalSubscriptions.$inferSelect) {
  if (isTerminalSubscriptionStatus(subscription.status)) return { status: 'cancelled' };
  const row = await configured(subscription.environment);
  if (row.merchant_id !== subscription.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
  const config = credentials(row);
  const requestId = subscription.cancel_request_id || randomUUID();
  const [claimed] = await db.update(paypalSubscriptions).set({ status: 'CANCELLATION_REQUESTED',
    cancellation_requested_at: subscription.cancellation_requested_at || new Date(), cancel_request_id: requestId, updated_at: new Date() })
    .where(and(eq(paypalSubscriptions.id, subscription.id), eq(paypalSubscriptions.status, subscription.status))).returning();
  if (!claimed) return { status: 'cancellation_unknown' };
  // Read back before a retry: a lost POST response may already have cancelled it.
  let detail = await paypalClient.getSubscription(config, subscription.id);
  assertSubscriptionIdentity(detail, subscription);
  if (detail.status !== 'CANCELLED' && detail.status !== 'EXPIRED') {
    try { await paypalClient.cancelSubscription(config, subscription.id, requestId); }
    catch { /* Provider may have committed despite a lost response. */ }
    detail = await paypalClient.getSubscription(config, subscription.id);
    assertSubscriptionIdentity(detail, subscription);
  }
  if (isTerminalSubscriptionStatus(detail.status)) {
    await db.update(paypalSubscriptions).set({ status: detail.status,
      cancelled_at: detail.status === 'CANCELLED' ? new Date(detail.status_update_time || Date.now()) : subscription.cancelled_at,
      updated_at: new Date() }).where(eq(paypalSubscriptions.id, subscription.id));
    return { status: 'cancelled' };
  }
  return { status: 'cancellation_unknown' };
}

export async function cancelSubscriptionsBeforeUserDeletion(userId: number) {
  const subscriptions = await db.select().from(paypalSubscriptions).where(eq(paypalSubscriptions.user_id, userId)).limit(101);
  if (subscriptions.length > 100) throw new PayPalError('SUBSCRIPTION_REVIEW_REQUIRED', 409);
  for (const subscription of subscriptions) {
    if (isTerminalSubscriptionStatus(subscription.status)) continue;
    try {
      const result = await cancelSubscriptionRecord(subscription);
      if (result.status !== 'cancelled') throw new PayPalError('SUBSCRIPTION_CANCELLATION_UNCONFIRMED', 409);
    } catch (err) {
      if (err instanceof PayPalError && err.status === 409) throw err;
      throw new PayPalError('SUBSCRIPTION_CANCELLATION_UNCONFIRMED', 409);
    }
  }
}

let inboxTimer: NodeJS.Timeout | null = null;
export function startPaypalInboxWorker() {
  if (inboxTimer) return;
  inboxTimer = setInterval(() => { void processPaypalInbox().catch(() => {}); }, 60_000);
  inboxTimer.unref();
  void processPaypalInbox().catch(() => {});
}
export function stopPaypalInboxWorker() { if (inboxTimer) clearInterval(inboxTimer); inboxTimer = null; }

function limitedTime(value: unknown): Date {
  const date = new Date(String(value || ''));
  if (!Number.isFinite(date.getTime())) throw new PayPalError('MALFORMED');
  return date;
}
export async function ingestCaptureRefund(config: PayPalCredentials, refundId: string, verification: string) {
  const refund = await paypalClient.getRefund(config, refundId);
  const normalized = normalizeCaptureRefund(refund);
  if (!normalized || normalized.transactionId !== refundId) throw new PayPalError('REFUND_NOT_COMPLETE', 409);
  const captureId = linkedCaptureId(refund, config.environment);
  const capture = await paypalClient.getCapture(config, captureId);
  const orderId = capture?.supplementary_data?.related_ids?.order_id;
  const [intent] = await db.select().from(paypalIntents).where(and(eq(paypalIntents.environment, config.environment),
    eq(paypalIntents.provider_id, orderId))).limit(1);
  if (!intent || intent.kind !== 'one_off' || intent.merchant_id !== capture?.payee?.merchant_id) throw new PayPalError('UNLINKED_REFUND', 409);
  // Refund-before-capture: the original receipt is posted from provider state
  // first, so the refund always links to an existing economic transaction.
  const receipt = await postOneOffCaptureDetail(intent, capture, verification);
  const result = await postCaptureRefund({ environment: intent.environment, merchantId: intent.merchant_id, intentId: intent.id, userId: intent.user_id },
    captureId, normalized, verification);
  const coverage = await settleCaptureAdjustments(config, intent, capture, verification);
  await db.update(paypalIntents).set({ status: receipt.status === 'posted' && coverage.status !== 'unresolved' ? 'verified' : 'net_unresolved',
    updated_at: new Date() }).where(eq(paypalIntents.id, intent.id));
  return result;
}

export async function ingestReportedAdjustment(config: PayPalCredentials, adjustmentId: string, eventType: string, eventAt: Date, verification: string) {
  const kind = eventType.endsWith('.REFUNDED') ? 'refund' : 'reversal';
  const from = new Date(eventAt.getTime() - 2 * 86_400_000);
  const to = new Date(eventAt.getTime() + 2 * 86_400_000);
  const report = await paypalClient.findReportedTransaction(config, adjustmentId, from, to);
  if (!Array.isArray(report.transaction_details) || report.transaction_details.length !== 1 || Number(report.total_pages || 1) > 1)
    throw new PayPalError('ADJUSTMENT_NOT_READY', 409);
  const normalized = normalizeReportedAdjustment(report.transaction_details[0], adjustmentId, kind);
  const originalKind = eventType.startsWith('PAYMENT.SALE.') ? 'sale' : 'capture';
  const [original] = await db.select().from(paypalTransactions).where(and(eq(paypalTransactions.environment, config.environment),
    eq(paypalTransactions.provider_transaction_id, normalized.originalTransactionId),
    eq(paypalTransactions.provider_kind, originalKind))).limit(1);
  if (!original || !original.intent_id || original.merchant_id !== (await configured(config.environment)).merchant_id)
    throw new PayPalError('UNLINKED_ADJUSTMENT', 409);
  const scope = { environment: original.environment, merchantId: original.merchant_id, intentId: original.intent_id, userId: original.user_id };
  const result = await postProviderAdjustment(scope, normalized.originalTransactionId, originalKind, kind, normalized, verification);
  // A newly recorded adjustment may complete an outstanding coverage placeholder.
  if (originalKind === 'sale') await settleSaleAdjustments(scope, original.provider_transaction_id, null, original.gross_ore ?? 0, original.effective_at);
  else {
    const [intent] = await db.select().from(paypalIntents).where(eq(paypalIntents.id, original.intent_id)).limit(1);
    if (intent?.provider_id) await settleCaptureAdjustments(config, intent, await paypalClient.getCapture(config, original.provider_transaction_id), verification);
  }
  return result;
}

export async function reconcileSubscription(subscription: typeof paypalSubscriptions.$inferSelect, from: Date, to: Date, expectedSaleId?: string) {
  const configRow = await configured(subscription.environment);
  if (configRow.merchant_id !== subscription.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
  const config = credentials(configRow);
  const detail = await paypalClient.getSubscription(config, subscription.id);
  if (detail.id !== subscription.id || detail.plan_id !== subscription.plan_id || detail.custom_id !== subscription.intent_id)
    throw new PayPalError('SUBSCRIPTION_MISMATCH', 409);
  const transactions = await listAllSubscriptionTransactions(config, subscription.id, from, to);
  if (expectedSaleId && !transactions.some((item: any) => item?.id === expectedSaleId)) throw new PayPalError('SALE_NOT_FOUND', 409);
  for (const item of transactions) {
    const normalized = normalizeSubscriptionTransaction(item, { amountOre: subscription.amount_ore });
    if (normalized) await postReceipt({ environment: subscription.environment, merchantId: subscription.merchant_id,
      intentId: subscription.intent_id, userId: subscription.user_id }, 'sale', normalized, 'subscription_transactions');
    if (normalized && isAdjustedSaleStatus(item.status)) await settleSaleAdjustments({ environment: subscription.environment,
      merchantId: subscription.merchant_id, intentId: subscription.intent_id, userId: subscription.user_id },
    normalized.transactionId, item.status, normalized.grossOre, normalized.effectiveAt);
  }
  const nextBilling = detail.billing_info?.next_billing_time ? limitedTime(detail.billing_info.next_billing_time) : null;
  const statuses = ['APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];
  const providerStatus = statuses.includes(detail.status) ? detail.status : 'UNKNOWN';
  await db.update(paypalSubscriptions).set({ status: subscription.cancellation_requested_at && !isTerminalSubscriptionStatus(providerStatus) ?
    'CANCELLATION_REQUESTED' : providerStatus,
    next_billing_at: nextBilling, updated_at: new Date(),
    // Never move the cursor backwards when a narrow webhook/enrichment window is checked.
    reconciled_through_at: sql`greatest(coalesce(${paypalSubscriptions.reconciled_through_at}, ${to}), ${to})`,
    cancelled_at: detail.status === 'CANCELLED' && detail.status_update_time ? limitedTime(detail.status_update_time) : subscription.cancelled_at })
    .where(eq(paypalSubscriptions.id, subscription.id));
  return { checked: transactions.length };
}

export type PaypalReconcileResult = { status: 'ok' | 'partial'; checked: number; failed: number };
const reconciliationRunning = new Map<string, Promise<PaypalReconcileResult>>();
const CAPTURE_RETRY_LIMIT = 5;
const STALE_CAPTURING_MS = 10 * 60_000;
const COMPLETED_CAPTURE_STATUSES = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'];
export function paypalItemBackoffMs(failures: number) {
  return Math.min(24 * 60 * 60_000, 15 * 60_000 * 2 ** Math.max(0, Math.min(failures - 1, 8)));
}
function failureCode(err: unknown) { return err instanceof PayPalError ? err.code : 'RECONCILIATION_FAILED'; }
// Metric labels and log fields carry only fixed vocabularies: never provider
// IDs, amounts, payer data or free-form provider text.
function reportReconcileFailure(environment: string, item: string, err: unknown) {
  const code = failureCode(err);
  log('warn', 'paypal_reconcile_item_failed', { environment, item, code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'OTHER' });
  incrementMetric('paypal_reconcile_failures', `environment="${environment}",item="${item}"`);
}

/**
 * Uncertain one-off captures: `capture_unknown`, or `capturing` left behind by
 * a crash. Always read the order back first. Only an order that PayPal still
 * reports APPROVED with no capture is captured again, reusing the persisted
 * PayPal-Request-Id; an order can only be captured once, so a retry can never
 * create a second payment.
 */
export async function reconcileUncertainCapture(config: PayPalCredentials, intent: typeof paypalIntents.$inferSelect) {
  if (!intent.provider_id || intent.kind !== 'one_off') return { status: 'skipped' };
  const order = await paypalClient.getOrder(config, intent.provider_id);
  const unit = Array.isArray(order?.purchase_units) && order.purchase_units.length === 1 ? order.purchase_units[0] : null;
  if (order?.id !== intent.provider_id || unit?.custom_id !== intent.id || unit?.payee?.merchant_id !== intent.merchant_id ||
      unit?.amount?.currency_code !== 'DKK' || unit?.amount?.value !== oreToDkk(intent.amount_ore)) throw new PayPalError('ORDER_MISMATCH', 409);
  const captures = Array.isArray(unit?.payments?.captures) ? unit.payments.captures.slice(0, 5) : [];
  const done = captures.find((item: any) => typeof item?.id === 'string' && COMPLETED_CAPTURE_STATUSES.includes(item.status));
  if (done) return ingestOneOffCapture(config, intent, done.id, 'reconciliation');
  const touch = (status: string) => db.update(paypalIntents).set({ status, updated_at: new Date() })
    .where(and(eq(paypalIntents.id, intent.id), eq(paypalIntents.status, intent.status)));
  if (captures.some((item: any) => item?.status === 'DECLINED' || item?.status === 'FAILED')) { await touch('capture_failed'); return { status: 'capture_failed' }; }
  if (captures.length) { await touch('capture_unknown'); return { status: 'pending_verification' }; }
  if (order.status === 'VOIDED') { await touch('expired'); return { status: 'expired' }; }
  if (order.status !== 'APPROVED' || !intent.capture_request_id || intent.capture_attempts >= CAPTURE_RETRY_LIMIT) {
    await touch('capture_unknown'); return { status: 'pending_verification' };
  }
  const claim = await db.update(paypalIntents).set({ status: 'capturing', capture_attempts: intent.capture_attempts + 1, updated_at: new Date() })
    .where(and(eq(paypalIntents.id, intent.id), eq(paypalIntents.status, intent.status), eq(paypalIntents.capture_attempts, intent.capture_attempts)));
  if (claim.rowCount !== 1) return { status: 'pending_verification' };
  let result: any;
  try { result = await paypalClient.captureOrder(config, intent.provider_id, intent.capture_request_id); }
  catch (err) {
    await db.update(paypalIntents).set({ status: 'capture_unknown', updated_at: new Date() }).where(eq(paypalIntents.id, intent.id));
    throw err;
  }
  const capture = result?.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture?.status === 'COMPLETED' && typeof capture.id === 'string')
    return ingestOneOffCapture(config, { ...intent, status: 'capturing' }, capture.id, 'reconciliation');
  await db.update(paypalIntents).set({ status: 'capture_unknown', updated_at: new Date() }).where(eq(paypalIntents.id, intent.id));
  return { status: 'pending_verification' };
}

/** Retry missing fee/net detail and adjustment coverage for one unresolved row. */
export async function enrichUnresolvedTransaction(config: PayPalCredentials, row: typeof paypalTransactions.$inferSelect) {
  if (!row.intent_id) throw new PayPalError('UNLINKED_TRANSACTION', 409);
  const [intent] = await db.select().from(paypalIntents).where(eq(paypalIntents.id, row.intent_id)).limit(1);
  if (!intent || intent.environment !== row.environment || intent.merchant_id !== row.merchant_id) throw new PayPalError('UNLINKED_TRANSACTION', 409);
  if (row.provider_kind === 'capture') return ingestOneOffCapture(config, intent, row.provider_transaction_id, 'reconciliation');
  if (row.provider_kind === 'capture_adjustment') return ingestOneOffCapture(config, intent, row.original_transaction_id!, 'reconciliation');
  if (row.provider_kind === 'sale' || row.provider_kind === 'sale_adjustment') {
    const [sub] = await db.select().from(paypalSubscriptions).where(and(eq(paypalSubscriptions.intent_id, intent.id),
      eq(paypalSubscriptions.environment, row.environment), eq(paypalSubscriptions.merchant_id, row.merchant_id))).limit(1);
    if (!sub) throw new PayPalError('UNLINKED_SALE', 409);
    const saleId = row.provider_kind === 'sale' ? row.provider_transaction_id : row.original_transaction_id!;
    let center = row.effective_at;
    if (!center) {
      const [sale] = await db.select({ effective_at: paypalTransactions.effective_at }).from(paypalTransactions)
        .where(and(eq(paypalTransactions.environment, row.environment), eq(paypalTransactions.merchant_id, row.merchant_id),
          eq(paypalTransactions.provider_transaction_id, saleId))).limit(1);
      center = sale?.effective_at ?? null;
    }
    if (!center) throw new PayPalError('SALE_TIME_UNKNOWN', 409);
    return reconcileSubscription(sub, new Date(center.getTime() - 2 * 86_400_000), new Date(center.getTime() + 86_400_000), saleId);
  }
  if (row.provider_kind === 'refund' || row.provider_kind === 'reversal') {
    const [original] = await db.select({ provider_kind: paypalTransactions.provider_kind }).from(paypalTransactions)
      .where(and(eq(paypalTransactions.environment, row.environment), eq(paypalTransactions.merchant_id, row.merchant_id),
        eq(paypalTransactions.provider_transaction_id, row.original_transaction_id || ''))).limit(1);
    if (!original) throw new PayPalError('ORIGINAL_RECEIPT_MISSING', 409);
    if (original.provider_kind === 'capture' && row.provider_kind === 'refund') return ingestCaptureRefund(config, row.provider_transaction_id, 'reconciliation');
    const eventType = `PAYMENT.${original.provider_kind === 'sale' ? 'SALE' : 'CAPTURE'}.${row.provider_kind === 'refund' ? 'REFUNDED' : 'REVERSED'}`;
    return ingestReportedAdjustment(config, row.provider_transaction_id, eventType, row.effective_at ?? row.observed_at, 'reconciliation');
  }
  throw new PayPalError('UNKNOWN_TRANSACTION_KIND', 409);
}

export async function reconcilePaypal(value: unknown, now = new Date()): Promise<PaypalReconcileResult> {
  const selectedEnvironment = environment(value);
  const active = reconciliationRunning.get(selectedEnvironment);
  if (active) return active;
  const work = (async (): Promise<PaypalReconcileResult> => {
    const env = selectedEnvironment;
    const row = await configured(env);
    const current = row.config_version;
    const config = credentials(row);
    const [prior] = await db.select().from(paypalReconciliation).where(eq(paypalReconciliation.environment, env)).limit(1);
    await db.insert(paypalReconciliation).values({ environment: env, status: 'running', last_run_at: now })
      .onConflictDoUpdate({ target: paypalReconciliation.environment, set: { status: 'running', last_run_at: now } });
    let checked = 0;
    const failures: string[] = [];
    // Returns null on success, otherwise the failure code (already reported).
    const isolate = async (item: string, fn: () => Promise<unknown>): Promise<string | null> => {
      try { await fn(); return null; }
      catch (err) { const code = failureCode(err); failures.push(code); reportReconcileFailure(env, item, err); return code; }
    };

    // 1. Missed-event recovery owns its cursor: it advances as soon as the
    // event window is persisted, regardless of later item failures.
    await isolate('events', async () => {
      const recovered = await recoverPaypalEvents(row, now, prior?.cursor_at ?? null);
      checked += recovered.stored;
      await db.update(paypalReconciliation).set({ cursor_at: recovered.through }).where(eq(paypalReconciliation.environment, env));
    });

    // 2. Uncertain one-off captures, including crash-orphaned `capturing`.
    const uncertain = await db.select().from(paypalIntents).where(and(eq(paypalIntents.environment, env),
      eq(paypalIntents.merchant_id, row.merchant_id!), eq(paypalIntents.kind, 'one_off'),
      or(eq(paypalIntents.status, 'capture_unknown'),
        and(eq(paypalIntents.status, 'capturing'), lt(paypalIntents.updated_at, new Date(now.getTime() - STALE_CAPTURING_MS))))))
      .orderBy(paypalIntents.updated_at).limit(10);
    for (const intent of uncertain) {
      if (await isolate('capture', () => reconcileUncertainCapture(config, intent)) === null) checked++;
      else await db.update(paypalIntents).set({ updated_at: new Date() }).where(eq(paypalIntents.id, intent.id));
    }

    // 3. Subscriptions, each isolated with its own backoff so one broken
    // mapping cannot abort the pass or monopolize the oldest-first ordering.
    const subscriptions = await db.select().from(paypalSubscriptions).where(and(eq(paypalSubscriptions.environment, env),
      eq(paypalSubscriptions.merchant_id, row.merchant_id!),
      or(notInArray(paypalSubscriptions.status, ['CANCELLED', 'EXPIRED']),
        gt(sql`coalesce(${paypalSubscriptions.cancelled_at}, ${paypalSubscriptions.updated_at})`, new Date(now.getTime() - 90 * 86_400_000))),
      or(isNull(paypalSubscriptions.reconcile_next_at), lte(paypalSubscriptions.reconcile_next_at, now))))
      .orderBy(sql`CASE WHEN ${paypalSubscriptions.status} = 'CANCELLATION_REQUESTED' THEN 0 ELSE 1 END`,
        sql`${paypalSubscriptions.reconciled_through_at} ASC NULLS FIRST`).limit(10);
    for (const sub of subscriptions) {
      if (sub.status === 'CANCELLATION_REQUESTED') {
        await isolate('cancellation', async () => {
          const cancellation = await cancelSubscriptionRecord(sub);
          if (cancellation.status !== 'cancelled') throw new PayPalError('SUBSCRIPTION_CANCELLATION_UNCONFIRMED', 409);
        });
      }
      const [fresh] = await db.select().from(paypalSubscriptions).where(eq(paypalSubscriptions.id, sub.id)).limit(1);
      const target = fresh || sub;
      const from = target.reconciled_through_at ? new Date(target.reconciled_through_at.getTime() - 7 * 86_400_000) :
        new Date(Math.max(0, now.getTime() - 30 * 86_400_000));
      const to = new Date(Math.min(now.getTime(), from.getTime() + 30 * 86_400_000));
      if (to <= from) continue;
      const code = await isolate('subscription', () => reconcileSubscription(target, from, to));
      if (code === null) { checked++; await db.update(paypalSubscriptions).set({ reconcile_failures: 0, reconcile_next_at: null, reconcile_error_code: null })
        .where(eq(paypalSubscriptions.id, sub.id)); }
      else {
        const count = (target.reconcile_failures ?? 0) + 1;
        await db.update(paypalSubscriptions).set({ reconcile_failures: count, reconcile_error_code: code,
          reconcile_next_at: new Date(now.getTime() + paypalItemBackoffMs(count)) }).where(eq(paypalSubscriptions.id, sub.id));
      }
    }

    // 4. Missing fee/net and adjustment coverage. Unknown stays unknown until
    // the provider reports it; nothing is estimated.
    const unresolved = await db.select().from(paypalTransactions).where(and(eq(paypalTransactions.environment, env),
      eq(paypalTransactions.merchant_id, row.merchant_id!), eq(paypalTransactions.status, 'net_unresolved'),
      or(isNull(paypalTransactions.next_retry_at), lte(paypalTransactions.next_retry_at, now))))
      .orderBy(paypalTransactions.observed_at).limit(20);
    for (const item of unresolved) {
      const code = await isolate('enrichment', () => enrichUnresolvedTransaction(config, item));
      if (code === null) checked++;
      const [after] = await db.select({ status: paypalTransactions.status }).from(paypalTransactions).where(eq(paypalTransactions.id, item.id)).limit(1);
      if (after?.status === 'net_unresolved') {
        const count = item.retry_count + 1;
        await db.update(paypalTransactions).set({ retry_count: count, last_error_code: code,
          next_retry_at: new Date(now.getTime() + paypalItemBackoffMs(count)) }).where(eq(paypalTransactions.id, item.id));
      }
    }

    const after = await configured(env);
    if (after.config_version !== current || after.merchant_id !== row.merchant_id) failures.unshift('CONFIG_CHANGED');
    const ok = failures.length === 0;
    await db.update(paypalReconciliation).set({ status: ok ? 'ok' : 'partial', error_code: ok ? null : failures[0],
      failed_items: failures.length, last_success_at: ok ? now : prior?.last_success_at ?? null,
      consecutive_failures: ok ? 0 : (prior?.consecutive_failures ?? 0) + 1 }).where(eq(paypalReconciliation.environment, env));
    return { status: ok ? 'ok' : 'partial', checked, failed: failures.length };
  })();
  reconciliationRunning.set(selectedEnvironment, work);
  try { return await work; } finally { if (reconciliationRunning.get(selectedEnvironment) === work) reconciliationRunning.delete(selectedEnvironment); }
}

let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationStartTimer: NodeJS.Timeout | null = null;
export function paypalReconcileIntervalMs(value = process.env.PAYPAL_RECONCILE_INTERVAL_MINUTES) {
  const minutes = value === undefined || value === '' ? 360 : Number(value);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) return 360 * 60_000;
  return minutes * 60_000;
}
async function scheduledReconciliation() {
  const setups = await paypalSetupStatus();
  for (const setup of setups) {
    if (!setup.configured) continue;
    try {
      const result = await reconcilePaypal(setup.environment);
      if (result.status !== 'ok') log('warn', 'paypal_reconcile_partial', { environment: setup.environment, failed: result.failed });
    } catch (err) { reportReconcileFailure(setup.environment, 'pass', err); }
  }
}
export function startPaypalReconciliation() {
  if (reconciliationTimer) return;
  const run = () => { void scheduledReconciliation().catch((err) => reportReconcileFailure('all', 'pass', err)); };
  // A startup pass (after boot settles) catches anything missed while down.
  reconciliationStartTimer = setTimeout(() => { reconciliationStartTimer = null; run(); }, 2 * 60_000);
  reconciliationTimer = setInterval(run, paypalReconcileIntervalMs());
  reconciliationStartTimer.unref(); reconciliationTimer.unref();
}
export function stopPaypalReconciliation() {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  if (reconciliationStartTimer) clearTimeout(reconciliationStartTimer);
  reconciliationTimer = null; reconciliationStartTimer = null;
}

export async function verifiedContributionSnapshot(value: unknown = 'live') {
  const env = environment(value);
  const [totals] = await db.select({
    grossOre: sql<number>`coalesce(sum(case when ${paypalPostings.posting_kind} = 'gross' then ${paypalPostings.amount_ore} else 0 end), 0)::int`,
    feeDebitsOre: sql<number>`coalesce(sum(case when ${paypalPostings.posting_kind} = 'fee' then ${paypalPostings.amount_ore} else 0 end), 0)::int`,
    refundDebitsOre: sql<number>`coalesce(sum(case when ${paypalPostings.posting_kind} in ('refund', 'reversal') then ${paypalPostings.amount_ore} else 0 end), 0)::int`,
    feeCreditsOre: sql<number>`coalesce(sum(case when ${paypalPostings.posting_kind} = 'fee_credit' then ${paypalPostings.amount_ore} else 0 end), 0)::int`,
    revision: sql<number>`coalesce(max(${paypalPostings.id}), 0)::int`,
  }).from(paypalPostings).where(eq(paypalPostings.environment, env));
  const [{ unresolved }] = await db.select({ unresolved: count() }).from(paypalTransactions)
    .where(and(eq(paypalTransactions.environment, env), eq(paypalTransactions.status, 'net_unresolved')));
  const [{ review }] = await db.select({ review: count() }).from(paypalWebhookInbox)
    .where(and(eq(paypalWebhookInbox.environment, env), eq(paypalWebhookInbox.status, 'needs_review')));
  const knownNetOre = totals.grossOre + totals.feeDebitsOre + totals.refundDebitsOre + totals.feeCreditsOre;
  // Known pending/held amounts are informational only and already excluded
  // from net; an eventual refund/reversal posting is the only deduction.
  const held = await openPaymentStateTotals(env);
  return { environment: env, grossOre: totals.grossOre, feeDebitsOre: totals.feeDebitsOre,
    refundDebitsOre: totals.refundDebitsOre, feeCreditsOre: totals.feeCreditsOre, knownNetOre,
    eligibleNetOre: unresolved || review ? null : Math.max(0, knownNetOre), unresolvedTransactions: unresolved,
    reviewEvents: review, ledgerRevision: totals.revision, paypalAccountBalanceKnown: false, ...held };
}
export async function reconcilePaypalManual(value: unknown, now = new Date()) {
  const env = environment(value);
  const [row] = await db.select().from(paypalReconciliation).where(eq(paypalReconciliation.environment, env)).limit(1);
  if (row?.last_run_at && now.getTime() - row.last_run_at.getTime() < 5 * 60_000) throw new PayPalError('RESYNC_RATE_LIMIT', 429);
  return reconcilePaypal(env, now);
}
