import { randomUUID } from 'node:crypto';
import { and, eq, desc, lt, notInArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalConfigs, paypalIntents, paypalPostings, paypalSubscriptions, paypalWebhookInbox } from '../db/schema/index.ts';
import { encryptSecret, decryptSecret } from '../utils/secrets.ts';
import { PayPalError, paypalClient, type PayPalEnvironment, type PayPalCredentials } from './paypalClient.ts';
import { normalizeCompletedCapture, oreToDkk, parseDkkOre } from './paypalMoney.ts';

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
  const feeOre = normalized.feeOre;
  if (normalized.netOre === null || feeOre === null) {
    await db.update(paypalIntents).set({ status: 'net_unresolved' }).where(eq(paypalIntents.id, intent.id));
    return { status: 'net_unresolved' };
  }
  await db.transaction(async (tx) => {
    await tx.insert(paypalPostings).values([
      { environment: intent.environment, merchant_id: intent.merchant_id, provider_transaction_id: normalized.transactionId,
        posting_kind: 'gross', source_id: captureId, intent_id: intent.id, user_id: intent.user_id, amount_ore: normalized.grossOre,
        currency: 'DKK', effective_at: normalized.effectiveAt, verification },
      { environment: intent.environment, merchant_id: intent.merchant_id, provider_transaction_id: normalized.transactionId,
        posting_kind: 'fee', source_id: captureId, intent_id: intent.id, user_id: intent.user_id, amount_ore: -feeOre,
        currency: 'DKK', effective_at: normalized.effectiveAt, verification },
    ]).onConflictDoNothing();
    await tx.update(paypalIntents).set({ status: 'verified', updated_at: new Date() }).where(eq(paypalIntents.id, intent.id));
  });
  return { status: 'verified' };
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
export async function ownPaymentHistory(userId: number) {
  const intents = await db.select({ id: paypalIntents.id, kind: paypalIntents.kind, status: paypalIntents.status,
    amountOre: paypalIntents.amount_ore, createdAt: paypalIntents.created_at, environment: paypalIntents.environment })
    .from(paypalIntents).where(eq(paypalIntents.user_id, userId)).orderBy(desc(paypalIntents.created_at)).limit(100);
  return intents;
}

export async function processPaypalInbox(limit = 20) {
  await db.update(paypalWebhookInbox).set({ status: 'pending', processing_at: null })
    .where(and(eq(paypalWebhookInbox.status, 'processing'), lt(paypalWebhookInbox.processing_at, new Date(Date.now() - 10 * 60_000))));
  const pending = await db.select().from(paypalWebhookInbox).where(eq(paypalWebhookInbox.status, 'pending'))
    .orderBy(paypalWebhookInbox.received_at).limit(Math.max(1, Math.min(limit, 50)));
  for (const entry of pending) {
    const claim = await db.update(paypalWebhookInbox).set({ status: 'processing', processing_at: new Date() })
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
        await ingestOneOffCapture(credentials(row), intent, resource.id, 'verified_webhook');
      }
      // Activation/pending/unknown events are evidence, never income.
      await db.update(paypalWebhookInbox).set({ status: 'processed', processed_at: new Date(), error_code: null })
        .where(eq(paypalWebhookInbox.id, entry.id));
    } catch (err) {
      const code = err instanceof PayPalError ? err.code : 'PROCESSING_FAILED';
      await db.update(paypalWebhookInbox).set({ status: 'needs_review', error_code: code }).where(eq(paypalWebhookInbox.id, entry.id));
    }
  }
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
  if (subscription.status === 'CANCELLED') return { status: 'cancelled' };
  const row = await configured(subscription.environment);
  if (row.merchant_id !== subscription.merchant_id) throw new PayPalError('CONFIG_CHANGED', 409);
  await db.update(paypalSubscriptions).set({ status: 'CANCELLATION_REQUESTED', cancellation_requested_at: new Date() }).where(eq(paypalSubscriptions.id, id));
  try { await paypalClient.cancelSubscription(credentials(row), id, randomUUID()); }
  catch { return { status: 'cancellation_unknown' }; }
  const detail = await paypalClient.getSubscription(credentials(row), id);
  if (detail.status === 'CANCELLED') {
    await db.update(paypalSubscriptions).set({ status: 'CANCELLED', cancelled_at: new Date(), updated_at: new Date() }).where(eq(paypalSubscriptions.id, id));
    return { status: 'cancelled' };
  }
  return { status: 'cancellation_unknown' };
}

let inboxTimer: NodeJS.Timeout | null = null;
export function startPaypalInboxWorker() {
  if (inboxTimer) return;
  inboxTimer = setInterval(() => { void processPaypalInbox().catch(() => {}); }, 60_000);
  inboxTimer.unref();
  void processPaypalInbox().catch(() => {});
}
export function stopPaypalInboxWorker() { if (inboxTimer) clearInterval(inboxTimer); inboxTimer = null; }
