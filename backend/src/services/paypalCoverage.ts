import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalIntents, paypalReconciliation, paypalTransactions, paypalWebhookInbox } from '../db/schema/index.ts';
import { PayPalError, paypalClient, type PayPalCredentials } from './paypalClient.ts';
import { normalizeCaptureRefund, providerOre } from './paypalMoney.ts';
import { postCaptureRefund } from './paypalLedger.ts';

// Refund/reversal coverage for receipts the provider already reports as
// (partially) refunded or reversed. The original gross is real money that was
// received, so it stays posted, but an `adjustment:<id>` placeholder keeps the
// receipt net_unresolved until every provider-reported adjustment has been
// recorded. A lost refund webhook therefore blocks finalized net instead of
// silently leaving refunded money counted as income.

type Scope = { environment: string; merchantId: string; intentId: string; userId: number | null };
type Intent = typeof paypalIntents.$inferSelect;

const ADJUSTED_CAPTURE_STATUSES = ['PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'];
const ADJUSTED_SALE_STATUSES = ['PARTIALLY_REFUNDED', 'REFUNDED'];

export function isAdjustedCaptureStatus(status: unknown) { return typeof status === 'string' && ADJUSTED_CAPTURE_STATUSES.includes(status); }
export function isAdjustedSaleStatus(status: unknown) { return typeof status === 'string' && ADJUSTED_SALE_STATUSES.includes(status); }

export function linkedCaptureId(refund: any, env: string): string {
  const link = Array.isArray(refund?.links) ? refund.links.find((entry: any) => entry?.rel === 'up' && entry?.method === 'GET') : null;
  let url: URL;
  try { url = new URL(link?.href); } catch { throw new PayPalError('REFUND_LINK_MISSING', 409); }
  const expected = env === 'sandbox' ? ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'] : ['api-m.paypal.com', 'api.paypal.com'];
  const match = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !expected.includes(url.host) || url.search || url.hash || !match) throw new PayPalError('REFUND_LINK_INVALID', 409);
  return match[1];
}

/**
 * Pure coverage rule. `covered` is the sum of recorded refund/reversal gross
 * for the original; `providerTotal` is a provider-reported cumulative refund
 * total when available (used only as a consistency check, never posted).
 */
export function adjustmentCoverageComplete(input: { status: string; grossOre: number; coveredOre: number;
  listingComplete: boolean; providerTotalOre?: number | null; eventsCoveredSinceObservation?: boolean }) {
  const { status, grossOre, coveredOre, listingComplete } = input;
  if (!Number.isSafeInteger(grossOre) || !Number.isSafeInteger(coveredOre) || coveredOre < 0 || coveredOre > grossOre) return false;
  if (status === 'REFUNDED' || status === 'REVERSED') return coveredOre === grossOre;
  if (status !== 'PARTIALLY_REFUNDED') return false;
  if (coveredOre <= 0 || coveredOre >= grossOre) return false;
  if (input.providerTotalOre != null && input.providerTotalOre !== coveredOre) return false;
  // Without an authoritative provider listing of every refund we require that
  // missed-webhook recovery has covered the period since the partial refund
  // was first observed.
  return listingComplete || input.eventsCoveredSinceObservation === true;
}

async function upsertPlaceholder(scope: Scope, originalId: string, kind: 'capture_adjustment' | 'sale_adjustment',
  providerStatus: string, effectiveAt: Date | null) {
  const now = new Date();
  await db.insert(paypalTransactions).values({ environment: scope.environment, merchant_id: scope.merchantId,
    provider_transaction_id: `adjustment:${originalId}`, provider_kind: kind, original_transaction_id: originalId,
    intent_id: scope.intentId, user_id: scope.userId, status: 'net_unresolved', currency: 'DKK', effective_at: effectiveAt,
    provider_status: providerStatus, observed_at: now })
    .onConflictDoUpdate({ target: [paypalTransactions.environment, paypalTransactions.merchant_id, paypalTransactions.provider_transaction_id],
      // A status change (for example a second partial refund turning the
      // receipt REFUNDED) reopens the placeholder and restarts observation.
      set: {
        status: sql`CASE WHEN ${paypalTransactions.provider_status} IS DISTINCT FROM ${providerStatus} THEN 'net_unresolved' ELSE ${paypalTransactions.status} END`,
        observed_at: sql`CASE WHEN ${paypalTransactions.provider_status} IS DISTINCT FROM ${providerStatus} THEN ${now} ELSE ${paypalTransactions.observed_at} END`,
        provider_status: providerStatus,
        effective_at: sql`coalesce(${paypalTransactions.effective_at}, ${effectiveAt})`,
      } });
  const [row] = await db.select().from(paypalTransactions).where(and(eq(paypalTransactions.environment, scope.environment),
    eq(paypalTransactions.merchant_id, scope.merchantId), eq(paypalTransactions.provider_transaction_id, `adjustment:${originalId}`))).limit(1);
  if (!row || row.provider_kind !== kind || row.intent_id !== scope.intentId) throw new PayPalError('TRANSACTION_CONFLICT', 409);
  return row;
}

async function recordedAdjustmentOre(environment: string, merchantId: string, originalId: string) {
  const [{ covered }] = await db.select({ covered: sql<number>`coalesce(sum(${paypalTransactions.gross_ore}), 0)::int` })
    .from(paypalTransactions).where(and(eq(paypalTransactions.environment, environment), eq(paypalTransactions.merchant_id, merchantId),
      eq(paypalTransactions.original_transaction_id, originalId), inArray(paypalTransactions.provider_kind, ['refund', 'reversal'])));
  return covered;
}

async function markPlaceholder(id: number, resolved: boolean) {
  await db.update(paypalTransactions).set(resolved ? { status: 'resolved', next_retry_at: null, last_error_code: null }
    : { status: 'net_unresolved' }).where(eq(paypalTransactions.id, id));
}

/**
 * Records every provider refund for a capture that PayPal reports as
 * PARTIALLY_REFUNDED/REFUNDED/REVERSED. Refunds come from the order readback
 * (`purchase_units[].payments.refunds`), each re-read from the refunds
 * endpoint and bound to this capture by its `up` link. Reversals cannot be
 * listed there; they arrive through the verified reversal event / reporting
 * lookup and are only counted once recorded.
 */
export async function settleCaptureAdjustments(config: PayPalCredentials, intent: Intent, capture: any, verification: string) {
  if (!isAdjustedCaptureStatus(capture?.status) || typeof capture.id !== 'string') return { status: 'not_adjusted' as const };
  const scope = { environment: intent.environment, merchantId: intent.merchant_id, intentId: intent.id, userId: intent.user_id };
  const effectiveAt = new Date(capture.create_time || capture.update_time);
  const placeholder = await upsertPlaceholder(scope, capture.id, 'capture_adjustment', capture.status,
    Number.isFinite(effectiveAt.getTime()) ? effectiveAt : null);
  let listingComplete = capture.status !== 'REVERSED';
  let providerTotal: number | null = null;
  if (capture.status !== 'REVERSED') {
    const order = await paypalClient.getOrder(config, intent.provider_id!);
    const unit = Array.isArray(order?.purchase_units) && order.purchase_units.length === 1 ? order.purchase_units[0] : null;
    if (order?.id !== intent.provider_id || unit?.custom_id !== intent.id || unit?.payee?.merchant_id !== intent.merchant_id)
      throw new PayPalError('ORDER_MISMATCH', 409);
    const refunds = unit?.payments?.refunds;
    if (!Array.isArray(refunds) || refunds.length > 50) listingComplete = false;
    for (const item of Array.isArray(refunds) ? refunds.slice(0, 50) : []) {
      if (typeof item?.id !== 'string') { listingComplete = false; continue; }
      if (item.status === 'CANCELLED' || item.status === 'FAILED') continue;
      if (item.status !== 'COMPLETED') { listingComplete = false; continue; }
      const refund = await paypalClient.getRefund(config, item.id);
      const normalized = normalizeCaptureRefund(refund);
      if (!normalized || normalized.transactionId !== item.id) { listingComplete = false; continue; }
      if (linkedCaptureId(refund, config.environment) !== capture.id) continue;
      await postCaptureRefund(scope, capture.id, normalized, verification);
      const total = providerOre(refund?.seller_payable_breakdown?.total_refunded_amount);
      if (total !== null) providerTotal = Math.max(providerTotal ?? 0, total);
    }
  }
  const covered = await recordedAdjustmentOre(intent.environment, intent.merchant_id, capture.id);
  const resolved = adjustmentCoverageComplete({ status: capture.status, grossOre: intent.amount_ore, coveredOre: covered,
    listingComplete, providerTotalOre: providerTotal });
  await markPlaceholder(placeholder.id, resolved);
  return { status: resolved ? 'resolved' as const : 'unresolved' as const };
}

/**
 * Subscription sales: the transaction list reports PARTIALLY_REFUNDED /
 * REFUNDED but not the refund rows themselves, which arrive via verified
 * PAYMENT.SALE.REFUNDED/REVERSED events and the reporting lookup. A full
 * refund resolves when the recorded adjustments equal the gross. A partial
 * refund resolves once something was recorded, nothing pending for sale
 * adjustments is still in the inbox, and missed-event recovery has advanced
 * past the moment the partial state was first observed.
 */
export async function settleSaleAdjustments(scope: Scope, saleId: string, providerStatus: string | null, grossOre: number,
  effectiveAt: Date | null) {
  let placeholder;
  if (providerStatus && isAdjustedSaleStatus(providerStatus)) {
    placeholder = await upsertPlaceholder(scope, saleId, 'sale_adjustment', providerStatus, effectiveAt);
  } else {
    [placeholder] = await db.select().from(paypalTransactions).where(and(eq(paypalTransactions.environment, scope.environment),
      eq(paypalTransactions.merchant_id, scope.merchantId), eq(paypalTransactions.provider_transaction_id, `adjustment:${saleId}`))).limit(1);
    if (!placeholder) return { status: 'not_adjusted' as const };
  }
  const status = providerStatus && isAdjustedSaleStatus(providerStatus) ? providerStatus : placeholder.provider_status || 'REFUNDED';
  const covered = await recordedAdjustmentOre(scope.environment, scope.merchantId, saleId);
  let eventsCovered = false;
  if (status === 'PARTIALLY_REFUNDED' && covered > 0) {
    const [cursor] = await db.select({ cursor_at: paypalReconciliation.cursor_at }).from(paypalReconciliation)
      .where(eq(paypalReconciliation.environment, scope.environment)).limit(1);
    const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(paypalWebhookInbox)
      .where(and(eq(paypalWebhookInbox.environment, scope.environment), eq(paypalWebhookInbox.merchant_id, scope.merchantId),
        inArray(paypalWebhookInbox.status, ['pending', 'processing', 'needs_review']),
        inArray(paypalWebhookInbox.event_type, ['PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'])));
    eventsCovered = open === 0 && Boolean(cursor?.cursor_at && cursor.cursor_at >= placeholder.observed_at);
  }
  const resolved = adjustmentCoverageComplete({ status, grossOre, coveredOre: covered, listingComplete: false,
    eventsCoveredSinceObservation: eventsCovered });
  await markPlaceholder(placeholder.id, resolved);
  return { status: resolved ? 'resolved' as const : 'unresolved' as const };
}
