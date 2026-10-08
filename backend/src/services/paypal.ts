import { randomUUID } from 'node:crypto';
import { and, eq, desc, lt, gt, or, isNull, lte, notInArray, sql, count } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalConfigs, paypalIntents, paypalSubscriptions, paypalWebhookInbox, paypalTransactions, paypalReconciliation, paypalPostings } from '../db/schema/index.ts';
import { encryptSecret, decryptSecret } from '../utils/secrets.ts';
import { PayPalError, paypalClient, type PayPalEnvironment, type PayPalCredentials } from './paypalClient.ts';
import { normalizeCompletedCapture, normalizeSubscriptionTransaction, normalizeCaptureRefund, normalizeReportedAdjustment, oreToDkk, parseDkkOre } from './paypalMoney.ts';
import { postReceipt, postCaptureRefund, postProviderAdjustment } from './paypalLedger.ts';

function environment(value: unknown): PayPalEnvironment {
  if (value !== 'sandbox' && value !== 'live') throw new PayPalError('INVALID_ENVIRONMENT', 400);
  return value;
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
export async function paypalSetupStatus() {
  const rows = await db.select().from(paypalConfigs);
  return rows.map((row) => ({ environment: row.environment, configured: Boolean(row.client_id && row.client_secret && row.merchant_id && row.webhook_id),
    enabled: row.enabled, merchantId: row.merchant_id, clientId: row.client_id, webhookId: row.webhook_id,
    monthlyPlanId: row.monthly_plan_id, monthlyAmountOre: row.monthly_amount_ore, configVersion: row.config_version }));
}
export async function savePaypalConfiguration(input: any) {
  const env = environment(input.environment);
  const clientId = String(input.clientId || ''); const secret = String(input.clientSecret || '');
  const merchant = String(input.merchantId || ''); const webhook = String(input.webhookId || '');
  const plan = input.monthlyPlanId == null ? null : String(input.monthlyPlanId);
  const monthlyOre = input.monthlyAmount == null || input.monthlyAmount === '' ? null : parseDkkOre(input.monthlyAmount);
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(clientId) || !secret || secret.length > 1024 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(merchant) || !/^[A-Za-z0-9_-]{8,128}$/.test(webhook) ||
      (plan !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(plan)) || Boolean(plan) !== Boolean(monthlyOre)) throw new PayPalError('INVALID_CONFIG', 400);
  const [old] = await db.select().from(paypalConfigs).where(eq(paypalConfigs.environment, env)).limit(1);
  if (old?.merchant_id && old.merchant_id !== merchant) {
    const [active] = await db.select({ id: paypalSubscriptions.id }).from(paypalSubscriptions)
      .where(and(eq(paypalSubscriptions.environment, env), eq(paypalSubscriptions.merchant_id, old.merchant_id), notInArray(paypalSubscriptions.status, ['CANCELLED', 'EXPIRED']))).limit(1);
    if (active) throw new PayPalError('ACTIVE_SUBSCRIPTIONS', 409);
  }
  await db.insert(paypalConfigs).values({ environment: env, client_id: clientId, client_secret: encryptSecret(secret), merchant_id: merchant,
    webhook_id: webhook, monthly_plan_id: plan, monthly_amount_ore: monthlyOre, enabled: false, config_version: 1 })
    .onConflictDoUpdate({ target: paypalConfigs.environment, set: { client_id: clientId, client_secret: encryptSecret(secret), merchant_id: merchant,
      webhook_id: webhook, monthly_plan_id: plan, monthly_amount_ore: monthlyOre, enabled: false, config_version: (old?.config_version ?? 0) + 1, updated_at: new Date() } });
  paypalClient.invalidate();
}
export async function setPaypalEnabled(value: unknown, enabled: boolean) {
  const row = await configured(value);
  if (enabled && row.monthly_plan_id) {
    const plan = await paypalClient.getPlan(credentials(row), row.monthly_plan_id);
    const cycle = plan.billing_cycles?.filter((item: any) => item.tenure_type === 'REGULAR');
    if (plan.status !== 'ACTIVE' || !Array.isArray(cycle) || cycle.length !== 1 || plan.billing_cycles.length !== 1 ||
        cycle[0].frequency?.interval_unit !== 'MONTH' || cycle[0].frequency?.interval_count !== 1 ||
        cycle[0].pricing_scheme?.fixed_price?.currency_code !== 'DKK' ||
        cycle[0].pricing_scheme?.fixed_price?.value !== oreToDkk(row.monthly_amount_ore!) ||
        plan.payment_preferences?.auto_bill_outstanding !== false || plan.payment_preferences?.setup_fee)
      throw new PayPalError('UNSAFE_MONTHLY_PLAN', 409);
  }
  await db.update(paypalConfigs).set({ enabled, config_version: row.config_version + 1, updated_at: new Date() }).where(eq(paypalConfigs.environment, row.environment));
  paypalClient.invalidate();
}
export async function createOneOff(userId: number, amount: string, value: unknown) {
  const row = await configured(value);
  if (!row.enabled) throw new PayPalError('CHECKOUT_DISABLED', 409);
  const amountOre = parseDkkOre(amount);
  const id = randomUUID(); const requestId = randomUUID();
  await db.insert(paypalIntents).values({ id, user_id: userId, environment: row.environment, merchant_id: row.merchant_id!, kind: 'one_off',
    amount_ore: amountOre, create_request_id: requestId, config_version: row.config_version });
  const order = await paypalClient.createOrder(credentials(row), oreToDkk(amountOre), id, requestId);
  if (typeof order.id !== 'string' || !['CREATED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) throw new PayPalError('ORDER_CREATE_UNKNOWN');
  await db.update(paypalIntents).set({ provider_id: order.id, status: 'approval_pending', updated_at: new Date() }).where(eq(paypalIntents.id, id));
  const approval = Array.isArray(order.links) ? order.links.find((link: any) => link.rel === 'approve' || link.rel === 'payer-action')?.href : null;
  const url = typeof approval === 'string' ? new URL(approval) : null;
  if (!url || url.protocol !== 'https:' || !['www.paypal.com', 'www.sandbox.paypal.com'].includes(url.host)) throw new PayPalError('APPROVAL_URL_INVALID');
  return { intentId: id, approvalUrl: url.href, status: 'approval_pending' };
}
export async function captureOneOff(userId: number, intentId: string) {
  const [intent] = await db.select().from(paypalIntents).where(and(eq(paypalIntents.id, intentId), eq(paypalIntents.user_id, userId))).limit(1);
  if (!intent || intent.kind !== 'one_off' || !intent.provider_id) throw new PayPalError('INTENT_NOT_FOUND', 404);
  const row = await configured(intent.environment);
  if (row.merchant_id !== intent.merchant_id || row.config_version !== intent.config_version) throw new PayPalError('CONFIG_CHANGED', 409);
  const config = credentials(row);
  const order = await paypalClient.getOrder(config, intent.provider_id);
  const unit = Array.isArray(order.purchase_units) && order.purchase_units.length === 1 ? order.purchase_units[0] : null;
  if (order.id !== intent.provider_id || order.status !== 'APPROVED' || unit?.custom_id !== intent.id ||
      unit?.payee?.merchant_id !== intent.merchant_id || unit?.amount?.currency_code !== 'DKK' ||
      unit?.amount?.value !== oreToDkk(intent.amount_ore)) throw new PayPalError('ORDER_MISMATCH', 409);
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
  const normalized = normalizeCompletedCapture(detail, { orderId: intent.provider_id!, merchantId: intent.merchant_id, amountOre: intent.amount_ore });
  const result = await postReceipt({ environment: intent.environment, merchantId: intent.merchant_id, intentId: intent.id, userId: intent.user_id },
    'capture', normalized, verification);
  await db.update(paypalIntents).set({ status: result.status === 'posted' ? 'verified' : 'net_unresolved', updated_at: new Date() })
    .where(eq(paypalIntents.id, intent.id));
  return { status: result.status === 'posted' ? 'verified' : 'net_unresolved' };
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
// The OAuth-authenticated, app-scoped event list recovers deliveries lost during an
// outage. Events still pass the normal local intent/merchant linkage checks.
export async function recoverPaypalEvents(row: Awaited<ReturnType<typeof configured>>, now: Date, cursor: Date | null) {
  const from = new Date(Math.max(now.getTime() - 30 * 86_400_000,
    (cursor?.getTime() ?? now.getTime() - 30 * 86_400_000) - 24 * 60 * 60_000));
  const to = new Date(Math.min(now.getTime(), from.getTime() + 7 * 86_400_000));
  if (to <= from) return { through: now, stored: 0 };
  const page = await paypalClient.listWebhookEvents(credentials(row), from, to);
  if (!Array.isArray(page.events) || page.events.length > 100 ||
      (Array.isArray(page.links) && page.links.some((link: any) => link?.rel === 'next')))
    throw new PayPalError('EVENTS_INCOMPLETE', 409);
  let stored = 0;
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
  return { through: to, stored };
}
export async function ownPaymentHistory(userId: number) {
  const intents = await db.select({ id: paypalIntents.id, kind: paypalIntents.kind, status: paypalIntents.status,
    amountOre: paypalIntents.amount_ore, createdAt: paypalIntents.created_at, environment: paypalIntents.environment })
    .from(paypalIntents).where(eq(paypalIntents.user_id, userId)).orderBy(desc(paypalIntents.created_at)).limit(100);
  return intents;
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
      }
      // Pending/denied/unknown events are evidence, never income.
      await db.update(paypalWebhookInbox).set({ status: 'processed', processed_at: new Date(), error_code: null })
        .where(eq(paypalWebhookInbox.id, entry.id));
    } catch (err) {
      const code = err instanceof PayPalError ? err.code : 'PROCESSING_FAILED';
      const retryable = ['ADJUSTMENT_NOT_READY', 'UNLINKED_ADJUSTMENT', 'UNLINKED_CAPTURE', 'UNLINKED_SALE', 'UNLINKED_REFUND', 'ORIGINAL_RECEIPT_MISSING',
        'HTTP_429', 'HTTP_503', 'NETWORK'].includes(code);
      const retry = retryable && entry.attempt_count < 10;
      await db.update(paypalWebhookInbox).set({ status: retry ? 'pending' : 'needs_review', error_code: code,
        processing_at: null, next_attempt_at: retry ? new Date(Date.now() + paypalInboxRetryDelayMs(entry.attempt_count + 1)) : null })
        .where(eq(paypalWebhookInbox.id, entry.id));
    }
  }
}
export function paypalInboxRetryDelayMs(attempt: number) {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, Math.min(attempt - 1, 10)));
}

export async function createMonthly(userId: number, value: unknown) {
  const row = await configured(value);
  if (!row.enabled || !row.monthly_plan_id || !row.monthly_amount_ore) throw new PayPalError('MONTHLY_DISABLED', 409);
  const id = randomUUID(); const requestId = randomUUID();
  await db.insert(paypalIntents).values({ id, user_id: userId, environment: row.environment, merchant_id: row.merchant_id!, kind: 'monthly',
    amount_ore: row.monthly_amount_ore, create_request_id: requestId, config_version: row.config_version });
  const result = await paypalClient.createSubscription(credentials(row), row.monthly_plan_id, id, requestId);
  if (typeof result.id !== 'string' || result.status !== 'APPROVAL_PENDING') throw new PayPalError('SUBSCRIPTION_CREATE_UNKNOWN');
  await db.transaction(async (tx) => {
    await tx.update(paypalIntents).set({ provider_id: result.id, status: 'approval_pending', updated_at: new Date() }).where(eq(paypalIntents.id, id));
    await tx.insert(paypalSubscriptions).values({ id: result.id, intent_id: id, user_id: userId, environment: row.environment,
      merchant_id: row.merchant_id!, status: 'APPROVAL_PENDING', plan_id: row.monthly_plan_id!, amount_ore: row.monthly_amount_ore! });
  });
  const approval = Array.isArray(result.links) ? result.links.find((link: any) => link.rel === 'approve')?.href : null;
  const url = typeof approval === 'string' ? new URL(approval) : null;
  if (!url || url.protocol !== 'https:' || !['www.paypal.com', 'www.sandbox.paypal.com'].includes(url.host)) throw new PayPalError('APPROVAL_URL_INVALID');
  return { intentId: id, subscriptionId: result.id, approvalUrl: url.href, status: 'approval_pending' };
}
export async function cancelMonthly(userId: number, id: string) {
  const [subscription] = await db.select().from(paypalSubscriptions).where(and(eq(paypalSubscriptions.id, id), eq(paypalSubscriptions.user_id, userId))).limit(1);
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
function linkedCaptureId(refund: any, env: string): string {
  const link = Array.isArray(refund.links) ? refund.links.find((entry: any) => entry.rel === 'up' && entry.method === 'GET') : null;
  let url: URL;
  try { url = new URL(link?.href); } catch { throw new PayPalError('REFUND_LINK_MISSING', 409); }
  const expected = env === 'sandbox' ? ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'] : ['api-m.paypal.com', 'api.paypal.com'];
  const match = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !expected.includes(url.host) || url.search || url.hash || !match) throw new PayPalError('REFUND_LINK_INVALID', 409);
  return match[1];
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
  await ingestOneOffCapture(config, intent, captureId, verification);
  return postCaptureRefund({ environment: intent.environment, merchantId: intent.merchant_id, intentId: intent.id, userId: intent.user_id },
    captureId, normalized, verification);
}

export async function ingestReportedAdjustment(config: PayPalCredentials, adjustmentId: string, eventType: string, eventAt: Date, verification: string) {
  const kind = eventType.endsWith('.REFUNDED') ? 'refund' : 'reversal';
  const from = new Date(eventAt.getTime() - 2 * 86_400_000);
  const to = new Date(eventAt.getTime() + 2 * 86_400_000);
  const result = await paypalClient.findReportedTransaction(config, adjustmentId, from, to);
  if (!Array.isArray(result.transaction_details) || result.transaction_details.length !== 1 || Number(result.total_pages || 1) > 1)
    throw new PayPalError('ADJUSTMENT_NOT_READY', 409);
  const normalized = normalizeReportedAdjustment(result.transaction_details[0], adjustmentId, kind);
  const originalKind = eventType.startsWith('PAYMENT.SALE.') ? 'sale' : 'capture';
  const [original] = await db.select().from(paypalTransactions).where(and(eq(paypalTransactions.environment, config.environment),
    eq(paypalTransactions.provider_transaction_id, normalized.originalTransactionId),
    eq(paypalTransactions.provider_kind, originalKind))).limit(1);
  if (!original || !original.intent_id || original.merchant_id !== (await configured(config.environment)).merchant_id)
    throw new PayPalError('UNLINKED_ADJUSTMENT', 409);
  return postProviderAdjustment({ environment: original.environment, merchantId: original.merchant_id,
    intentId: original.intent_id, userId: original.user_id }, normalized.originalTransactionId, originalKind, kind, normalized, verification);
}

export async function reconcileSubscription(subscription: typeof paypalSubscriptions.$inferSelect, from: Date, to: Date, expectedSaleId?: string) {
  const configRow = await configured(subscription.environment);
  if (configRow.merchant_id !== subscription.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
  const config = credentials(configRow);
  const detail = await paypalClient.getSubscription(config, subscription.id);
  if (detail.id !== subscription.id || detail.plan_id !== subscription.plan_id || detail.custom_id !== subscription.intent_id)
    throw new PayPalError('SUBSCRIPTION_MISMATCH', 409);
  const page = await paypalClient.listSubscriptionTransactions(config, subscription.id, from, to);
  if (!Array.isArray(page.transactions) || Number(page.total_pages || 1) > 1 || page.transactions.length > 200)
    throw new PayPalError('TRANSACTIONS_INCOMPLETE', 409);
  if (expectedSaleId && !page.transactions.some((item: any) => item.id === expectedSaleId)) throw new PayPalError('SALE_NOT_FOUND', 409);
  for (const item of page.transactions) {
    const normalized = normalizeSubscriptionTransaction(item, { amountOre: subscription.amount_ore });
    if (normalized) await postReceipt({ environment: subscription.environment, merchantId: subscription.merchant_id,
      intentId: subscription.intent_id, userId: subscription.user_id }, 'sale', normalized, 'subscription_transactions');
    if (['PARTIALLY_REFUNDED', 'REFUNDED'].includes(item.status) && typeof item.id === 'string') {
      await db.insert(paypalTransactions).values({ environment: subscription.environment, merchant_id: subscription.merchant_id,
        provider_transaction_id: `adjustment:${item.id}`, provider_kind: 'sale_adjustment', original_transaction_id: item.id,
        intent_id: subscription.intent_id, user_id: subscription.user_id, status: 'net_unresolved', currency: 'DKK' })
        .onConflictDoNothing();
      if (item.status === 'REFUNDED') {
        const [total] = await db.select({ amount: sql<number>`coalesce(sum(-${paypalPostings.amount_ore}), 0)::int` })
          .from(paypalPostings).where(and(eq(paypalPostings.environment, subscription.environment),
            eq(paypalPostings.merchant_id, subscription.merchant_id), eq(paypalPostings.original_transaction_id, item.id),
            sql`${paypalPostings.posting_kind} IN ('refund', 'reversal')`));
        if (total.amount >= subscription.amount_ore) await db.update(paypalTransactions).set({ status: 'posted', observed_at: new Date() })
          .where(and(eq(paypalTransactions.environment, subscription.environment), eq(paypalTransactions.merchant_id, subscription.merchant_id),
            eq(paypalTransactions.provider_transaction_id, `adjustment:${item.id}`)));
      }
      continue;
    }
  }
  const nextBilling = detail.billing_info?.next_billing_time ? limitedTime(detail.billing_info.next_billing_time) : null;
  const statuses = ['APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];
  const providerStatus = statuses.includes(detail.status) ? detail.status : 'UNKNOWN';
  await db.update(paypalSubscriptions).set({ status: subscription.cancellation_requested_at && !isTerminalSubscriptionStatus(providerStatus) ?
    'CANCELLATION_REQUESTED' : providerStatus,
    next_billing_at: nextBilling, reconciled_through_at: to, updated_at: new Date(),
    cancelled_at: detail.status === 'CANCELLED' && detail.status_update_time ? limitedTime(detail.status_update_time) : subscription.cancelled_at })
    .where(eq(paypalSubscriptions.id, subscription.id));
  return { checked: page.transactions.length };
}

const reconciliationRunning = new Map<string, Promise<unknown>>();
export async function reconcilePaypal(value: unknown, now = new Date()) {
  const selectedEnvironment = environment(value);
  const active = reconciliationRunning.get(selectedEnvironment);
  if (active) return active;
  const work = (async () => {
    const env = environment(value);
    const row = await configured(env);
    const current = row.config_version;
    const [prior] = await db.select().from(paypalReconciliation).where(eq(paypalReconciliation.environment, env)).limit(1);
    await db.insert(paypalReconciliation).values({ environment: env, status: 'running', last_run_at: now })
      .onConflictDoUpdate({ target: paypalReconciliation.environment, set: { status: 'running', last_run_at: now } });
    let checked = 0;
    try {
      const recovered = await recoverPaypalEvents(row, now, prior?.cursor_at ?? null);
      checked += recovered.stored;
      const unresolved = await db.select().from(paypalIntents).where(and(eq(paypalIntents.environment, env),
        eq(paypalIntents.merchant_id, row.merchant_id!), eq(paypalIntents.status, 'capture_unknown'))).limit(10);
      for (const intent of unresolved) {
        if (!intent.provider_id) continue;
        const order = await paypalClient.getOrder(credentials(row), intent.provider_id);
        const captures = order.purchase_units?.[0]?.payments?.captures;
        if (!Array.isArray(captures)) continue;
        for (const capture of captures.slice(0, 2)) if (capture.status === 'COMPLETED') {
          await ingestOneOffCapture(credentials(row), intent, capture.id, 'reconciliation'); checked++;
        }
      }
      const subscriptions = await db.select().from(paypalSubscriptions).where(and(eq(paypalSubscriptions.environment, env),
        eq(paypalSubscriptions.merchant_id, row.merchant_id!), or(
          notInArray(paypalSubscriptions.status, ['CANCELLED', 'EXPIRED']),
          gt(paypalSubscriptions.updated_at, new Date(now.getTime() - 90 * 86_400_000)))))
        .orderBy(sql`CASE WHEN ${paypalSubscriptions.cancellation_requested_at} IS NOT NULL AND ${paypalSubscriptions.status} = 'CANCELLATION_REQUESTED' THEN 0 ELSE 1 END`,
          paypalSubscriptions.reconciled_through_at).limit(10);
      let cancellationUnconfirmed = false;
      for (const sub of subscriptions) {
        if (sub.status === 'CANCELLATION_REQUESTED') {
          try {
            const cancellation = await cancelSubscriptionRecord(sub);
            if (cancellation.status !== 'cancelled') cancellationUnconfirmed = true;
          } catch { cancellationUnconfirmed = true; }
        }
        const from = sub.reconciled_through_at ? new Date(sub.reconciled_through_at.getTime() - 7 * 86_400_000) :
          new Date(Math.max(0, now.getTime() - 30 * 86_400_000));
        const to = new Date(Math.min(now.getTime(), from.getTime() + 30 * 86_400_000));
        if (to <= from) continue;
        await reconcileSubscription(sub, from, to);
        checked++;
      }
      if (cancellationUnconfirmed) throw new PayPalError('SUBSCRIPTION_CANCELLATION_UNCONFIRMED', 409);
      const after = await configured(env);
      if (after.config_version !== current || after.merchant_id !== row.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
      await db.update(paypalReconciliation).set({ status: 'ok', cursor_at: recovered.through, error_code: null }).where(eq(paypalReconciliation.environment, env));
      return { status: 'ok', checked };
    } catch (err) {
      await db.update(paypalReconciliation).set({ status: 'partial', error_code: err instanceof PayPalError ? err.code : 'RECONCILIATION_FAILED' })
        .where(eq(paypalReconciliation.environment, env));
      throw err;
    }
  })();
  reconciliationRunning.set(selectedEnvironment, work);
  try { return await work; } finally { if (reconciliationRunning.get(selectedEnvironment) === work) reconciliationRunning.delete(selectedEnvironment); }
}

let reconciliationTimer: NodeJS.Timeout | null = null;
export function startPaypalReconciliation() {
  if (reconciliationTimer) return;
  reconciliationTimer = setInterval(() => { void Promise.allSettled([reconcilePaypal('sandbox'), reconcilePaypal('live')]); }, 6 * 60 * 60_000);
  reconciliationTimer.unref();
}
export function stopPaypalReconciliation() { if (reconciliationTimer) clearInterval(reconciliationTimer); reconciliationTimer = null; }

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
  return { environment: env, grossOre: totals.grossOre, feeDebitsOre: totals.feeDebitsOre,
    refundDebitsOre: totals.refundDebitsOre, feeCreditsOre: totals.feeCreditsOre, knownNetOre,
    eligibleNetOre: unresolved || review ? null : Math.max(0, knownNetOre), unresolvedTransactions: unresolved,
    reviewEvents: review, ledgerRevision: totals.revision, paypalAccountBalanceKnown: false };
}
export async function reconcilePaypalManual(value: unknown, now = new Date()) {
  const env = environment(value);
  const [row] = await db.select().from(paypalReconciliation).where(eq(paypalReconciliation.environment, env)).limit(1);
  if (row?.last_run_at && now.getTime() - row.last_run_at.getTime() < 5 * 60_000) throw new PayPalError('RESYNC_RATE_LIMIT', 429);
  return reconcilePaypal(env, now);
}
