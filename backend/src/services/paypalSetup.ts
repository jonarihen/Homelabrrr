import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalConfigHistory, paypalSetupResources } from '../db/schema/index.ts';
import { PayPalError, paypalClient, type PayPalCredentials } from './paypalClient.ts';
import { oreToDkk, parseDkkOre } from './paypalMoney.ts';
import { paypalSetupCredentials, validateMonthlyPlan } from './paypal.ts';

// Administrator setup actions. None of these runs at startup, none charges,
// and each provider resource is created at most once per environment and REST
// app: the PayPal-Request-Id is persisted before the call and reused.

export const PAYPAL_WEBHOOK_EVENT_TYPES = [
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED',
  'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED',
];

export function expectedWebhookUrl(environment: string) {
  const configured = process.env.PORTAL_BASE_URL || process.env.ALLOWED_ORIGIN;
  let base: URL;
  try { base = new URL(configured || ''); } catch { throw new PayPalError('RETURN_ORIGIN_NOT_CONFIGURED', 409); }
  // PayPal only delivers to HTTPS; the callback is the one public path.
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new PayPalError('WEBHOOK_ORIGIN_INVALID', 409);
  return `${base.origin}/api/payments/paypal/webhook/${environment}`;
}

type Check = { name: string; ok: boolean; code?: string };
async function check(name: string, fn: () => Promise<void>): Promise<Check> {
  try { await fn(); return { name, ok: true }; }
  catch (err) { return { name, ok: false, code: err instanceof PayPalError ? err.code : 'CHECK_FAILED' }; }
}

/** Read-only connection test: credentials, webhook registration and plan safety. */
export async function testPaypalConnection(environment: unknown) {
  const { row, config } = await paypalSetupCredentials(environment);
  const checks: Check[] = [];
  checks.push(await check('credentials', async () => { await paypalClient.listWebhooks(config); }));
  checks.push(await check('webhook', async () => {
    if (!row.webhook_id) throw new PayPalError('WEBHOOK_NOT_CONFIGURED', 409);
    const hook = await paypalClient.getWebhook(config, row.webhook_id);
    if (hook?.id !== row.webhook_id || hook?.url !== expectedWebhookUrl(row.environment)) throw new PayPalError('WEBHOOK_URL_MISMATCH', 409);
    const names = new Set((Array.isArray(hook.event_types) ? hook.event_types : []).map((item: any) => item?.name));
    if (!names.has('*') && PAYPAL_WEBHOOK_EVENT_TYPES.some((name) => !names.has(name))) throw new PayPalError('WEBHOOK_EVENTS_MISSING', 409);
  }));
  if (row.monthly_plan_id) checks.push(await check('monthly_plan', async () => {
    validateMonthlyPlan(await paypalClient.getPlan(config, row.monthly_plan_id!), row.monthly_amount_ore!);
  }));
  return { environment: row.environment, configVersion: row.config_version, ok: checks.every((item) => item.ok), checks };
}

async function claimResource(config: PayPalCredentials, kind: string, key: string) {
  await db.insert(paypalSetupResources).values({ environment: config.environment, client_id: config.clientId, kind, resource_key: key,
    request_id: randomUUID() }).onConflictDoNothing();
  const [resource] = await db.select().from(paypalSetupResources).where(and(eq(paypalSetupResources.environment, config.environment),
    eq(paypalSetupResources.client_id, config.clientId), eq(paypalSetupResources.kind, kind), eq(paypalSetupResources.resource_key, key))).limit(1);
  if (!resource) throw new PayPalError('SETUP_CONFLICT', 409);
  return resource;
}
async function completeResource(id: number, providerId: unknown) {
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) throw new PayPalError('SETUP_RESPONSE_INVALID');
  await db.update(paypalSetupResources).set({ provider_id: providerId, status: 'created', updated_at: new Date() }).where(eq(paypalSetupResources.id, id));
  return providerId;
}

/**
 * Create (or return the already created) product, monthly plan or webhook
 * registration. Plans are server-defined: fixed DKK monthly price, no setup
 * fee or trial, `auto_bill_outstanding: false`. The returned ID still has to
 * be saved into the configuration explicitly.
 */
export async function provisionPaypalResource(environment: unknown, kind: unknown, input: { amount?: unknown } = {}) {
  const { config } = await paypalSetupCredentials(environment);
  if (kind === 'product') {
    const resource = await claimResource(config, 'product', 'default');
    if (resource.provider_id) return { kind, providerId: resource.provider_id, created: false };
    const product = await paypalClient.createProduct(config, resource.request_id);
    return { kind, providerId: await completeResource(resource.id, product?.id), created: true };
  }
  if (kind === 'plan') {
    const amountOre = parseDkkOre(input.amount);
    const [product] = await db.select().from(paypalSetupResources).where(and(eq(paypalSetupResources.environment, config.environment),
      eq(paypalSetupResources.client_id, config.clientId), eq(paypalSetupResources.kind, 'product'))).limit(1);
    if (!product?.provider_id) throw new PayPalError('PRODUCT_REQUIRED', 409);
    const resource = await claimResource(config, 'plan', String(amountOre));
    if (resource.provider_id) return { kind, providerId: resource.provider_id, amountOre, created: false };
    const plan = await paypalClient.createMonthlyPlan(config, product.provider_id, oreToDkk(amountOre), resource.request_id);
    validateMonthlyPlan({ ...plan, status: plan?.status ?? 'ACTIVE' }, amountOre);
    return { kind, providerId: await completeResource(resource.id, plan?.id), amountOre, created: true };
  }
  if (kind === 'webhook') {
    const url = expectedWebhookUrl(config.environment);
    const resource = await claimResource(config, 'webhook', url);
    if (resource.provider_id) return { kind, providerId: resource.provider_id, created: false };
    // The webhooks endpoint has no documented request-ID idempotency, so
    // reuse an existing registration for the same URL instead of duplicating.
    const listing = await paypalClient.listWebhooks(config);
    const existing = Array.isArray(listing?.webhooks) ? listing.webhooks.find((item: any) => item?.url === url) : null;
    if (existing) return { kind, providerId: await completeResource(resource.id, existing.id), created: false };
    const hook = await paypalClient.createWebhook(config, url, PAYPAL_WEBHOOK_EVENT_TYPES);
    return { kind, providerId: await completeResource(resource.id, hook?.id), created: true };
  }
  throw new PayPalError('INVALID_SETUP_KIND', 400);
}

export async function paypalConfigHistoryList(environment: unknown) {
  if (environment !== 'sandbox' && environment !== 'live') throw new PayPalError('INVALID_ENVIRONMENT', 400);
  return db.select({ configVersion: paypalConfigHistory.config_version, action: paypalConfigHistory.action, actorUserId: paypalConfigHistory.actor_user_id,
    clientId: paypalConfigHistory.client_id, merchantId: paypalConfigHistory.merchant_id, webhookId: paypalConfigHistory.webhook_id,
    monthlyPlanId: paypalConfigHistory.monthly_plan_id, monthlyAmountOre: paypalConfigHistory.monthly_amount_ore, enabled: paypalConfigHistory.enabled,
    secretChanged: paypalConfigHistory.secret_changed, createdAt: paypalConfigHistory.created_at })
    .from(paypalConfigHistory).where(eq(paypalConfigHistory.environment, environment))
    .orderBy(desc(paypalConfigHistory.created_at), desc(paypalConfigHistory.id)).limit(50);
}
