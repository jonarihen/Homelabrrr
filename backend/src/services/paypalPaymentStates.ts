import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalIntents, paypalPaymentStates, paypalSubscriptions, paypalTransactions } from '../db/schema/index.ts';
import { providerOre } from './paypalMoney.ts';

// Records pending/denied/dispute provider states for payments linked to this
// integration. Nothing here posts or subtracts money. Unlinked resources
// (unrelated account activity) are ignored and reported as `unlinked`.

type Entry = { environment: string; merchant_id: string; event_type: string };
const code = (value: unknown) => (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null);

async function upsertState(entry: Entry, kind: 'pending' | 'dispute', ref: string, values: { status: string; intentId: string | null;
  relatedId?: string | null; amountOre?: number | null; reason?: string | null }) {
  const closed = values.status !== 'open';
  const now = new Date();
  await db.insert(paypalPaymentStates).values({ environment: entry.environment, merchant_id: entry.merchant_id, kind, provider_ref: ref,
    related_transaction_id: values.relatedId ?? null, intent_id: values.intentId, status: values.status, amount_ore: values.amountOre ?? null,
    reason_code: values.reason ?? null, closed_at: closed ? now : null })
    .onConflictDoUpdate({ target: [paypalPaymentStates.environment, paypalPaymentStates.merchant_id, paypalPaymentStates.kind, paypalPaymentStates.provider_ref],
      // A closed state never reopens from an older/delayed delivery.
      set: { status: sql`CASE WHEN ${paypalPaymentStates.closed_at} IS NULL THEN ${values.status} ELSE ${paypalPaymentStates.status} END`,
        closed_at: sql`coalesce(${paypalPaymentStates.closed_at}, ${closed ? now : null})`,
        amount_ore: sql`coalesce(${values.amountOre ?? null}, ${paypalPaymentStates.amount_ore})`,
        reason_code: sql`coalesce(${values.reason ?? null}, ${paypalPaymentStates.reason_code})`, updated_at: now } });
}

async function intentForOrder(entry: Entry, orderId: unknown) {
  if (typeof orderId !== 'string') return null;
  const [intent] = await db.select().from(paypalIntents).where(and(eq(paypalIntents.environment, entry.environment),
    eq(paypalIntents.merchant_id, entry.merchant_id), eq(paypalIntents.provider_id, orderId))).limit(1);
  return intent ?? null;
}
async function intentForSubscription(entry: Entry, subscriptionId: unknown) {
  if (typeof subscriptionId !== 'string') return null;
  const [sub] = await db.select({ intent_id: paypalSubscriptions.intent_id }).from(paypalSubscriptions).where(and(eq(paypalSubscriptions.id, subscriptionId),
    eq(paypalSubscriptions.environment, entry.environment), eq(paypalSubscriptions.merchant_id, entry.merchant_id))).limit(1);
  return sub?.intent_id ?? null;
}

export const PAYMENT_STATE_EVENTS = new Set(['PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.SALE.PENDING', 'PAYMENT.SALE.DENIED', 'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED']);

/** Returns 'recorded' or 'unlinked'. */
export async function recordPaymentStateEvent(entry: Entry, resource: any): Promise<'recorded' | 'unlinked'> {
  const type = entry.event_type;
  if (type.startsWith('PAYMENT.CAPTURE.') || type.startsWith('PAYMENT.SALE.')) {
    if (typeof resource?.id !== 'string') return 'unlinked';
    const intentId = type.startsWith('PAYMENT.CAPTURE.')
      ? (await intentForOrder(entry, resource?.supplementary_data?.related_ids?.order_id))?.id ?? null
      : await intentForSubscription(entry, resource?.billing_agreement_id);
    if (!intentId) return 'unlinked';
    const pending = type.endsWith('.PENDING');
    // Out-of-order delivery: a PENDING arriving after the receipt was
    // recorded must not reopen a hold.
    const [known] = pending ? await db.select({ id: paypalTransactions.id }).from(paypalTransactions).where(and(
      eq(paypalTransactions.environment, entry.environment), eq(paypalTransactions.merchant_id, entry.merchant_id),
      eq(paypalTransactions.provider_transaction_id, resource.id))).limit(1) : [];
    await upsertState(entry, 'pending', resource.id, { status: known ? 'completed' : pending ? 'open' : 'denied', intentId,
      amountOre: providerOre(resource.amount), reason: code(resource.status_details?.reason) });
    if (!pending && type.startsWith('PAYMENT.CAPTURE.')) await db.update(paypalIntents).set({ status: 'capture_failed', updated_at: new Date() })
      .where(and(eq(paypalIntents.id, intentId), inArray(paypalIntents.status, ['capture_unknown', 'capturing', 'approval_pending'])));
    return 'recorded';
  }
  // Disputes: link through a disputed seller transaction we recorded.
  const disputeId = resource?.dispute_id;
  if (typeof disputeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(disputeId)) return 'unlinked';
  const sellerIds = (Array.isArray(resource?.disputed_transactions) ? resource.disputed_transactions : [])
    .map((item: any) => item?.seller_transaction_id).filter((id: unknown) => typeof id === 'string').slice(0, 10);
  if (!sellerIds.length) return 'unlinked';
  const [linked] = await db.select().from(paypalTransactions).where(and(eq(paypalTransactions.environment, entry.environment),
    eq(paypalTransactions.merchant_id, entry.merchant_id), inArray(paypalTransactions.provider_transaction_id, sellerIds))).limit(1);
  if (!linked) return 'unlinked';
  const resolved = type === 'CUSTOMER.DISPUTE.RESOLVED' || resource?.status === 'RESOLVED';
  await upsertState(entry, 'dispute', disputeId, { status: resolved ? 'resolved' : 'open', intentId: linked.intent_id,
    relatedId: linked.provider_transaction_id, amountOre: providerOre(resource?.dispute_amount),
    reason: code(resolved ? resource?.dispute_outcome?.outcome_code : resource?.reason) });
  return 'recorded';
}

/** A completed capture/sale closes its pending state. */
export async function closePendingState(environment: string, merchantId: string, providerRef: string) {
  await db.update(paypalPaymentStates).set({ status: 'completed', closed_at: new Date(), updated_at: new Date() })
    .where(and(eq(paypalPaymentStates.environment, environment), eq(paypalPaymentStates.merchant_id, merchantId),
      eq(paypalPaymentStates.kind, 'pending'), eq(paypalPaymentStates.provider_ref, providerRef), eq(paypalPaymentStates.status, 'open')));
}

export async function openPaymentStateTotals(environment: string) {
  const rows = await db.select({ kind: paypalPaymentStates.kind, count: sql<number>`count(*)::int`,
    amount: sql<number>`coalesce(sum(${paypalPaymentStates.amount_ore}), 0)::int`,
    unknown: sql<number>`count(*) filter (where ${paypalPaymentStates.amount_ore} is null)::int` })
    .from(paypalPaymentStates).where(and(eq(paypalPaymentStates.environment, environment), eq(paypalPaymentStates.status, 'open')))
    .groupBy(paypalPaymentStates.kind);
  const of = (kind: string) => rows.find((row) => row.kind === kind) ?? { count: 0, amount: 0, unknown: 0 };
  return { pendingCount: of('pending').count, pendingOre: of('pending').amount, pendingAmountUnknown: of('pending').unknown,
    disputeCount: of('dispute').count, disputedOre: of('dispute').amount, disputeAmountUnknown: of('dispute').unknown };
}
