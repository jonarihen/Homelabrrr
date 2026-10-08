import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalPostings, paypalTransactions } from '../db/schema/index.ts';
import { PayPalError } from './paypalClient.ts';

type Scope = { environment: string; merchantId: string; intentId: string; userId: number | null };
type Receipt = { transactionId: string; grossOre: number; feeOre: number | null; netOre: number | null; effectiveAt: Date };
type Refund = { transactionId: string; grossOre: number; feeCreditOre: number | null; netDebitOre: number | null; effectiveAt: Date };

export async function postReceipt(scope: Scope, kind: 'capture' | 'sale', receipt: Receipt, verification: string) {
  if (receipt.grossOre <= 0 || !Number.isSafeInteger(receipt.grossOre)) throw new PayPalError('INVALID_RECEIPT');
  const complete = receipt.feeOre !== null && receipt.netOre !== null;
  const outcome = await db.transaction(async (tx) => {
    const record = { environment: scope.environment, merchant_id: scope.merchantId, provider_transaction_id: receipt.transactionId,
      provider_kind: kind, intent_id: scope.intentId, user_id: scope.userId, status: 'net_unresolved',
      currency: 'DKK', gross_ore: receipt.grossOre, fee_ore: receipt.feeOre, net_ore: receipt.netOre, effective_at: receipt.effectiveAt,
      observed_at: new Date() };
    await tx.insert(paypalTransactions).values(record).onConflictDoNothing();
    const [prior] = await tx.select().from(paypalTransactions).where(and(
      eq(paypalTransactions.environment, scope.environment), eq(paypalTransactions.merchant_id, scope.merchantId),
      eq(paypalTransactions.provider_transaction_id, receipt.transactionId))).for('update');
    if (!prior || prior.provider_kind !== kind || prior.intent_id !== scope.intentId || prior.gross_ore !== receipt.grossOre)
      throw new PayPalError('TRANSACTION_CONFLICT', 409);
    if (prior.status === 'posted') {
      if (complete && (prior.fee_ore !== receipt.feeOre || prior.net_ore !== receipt.netOre))
        throw new PayPalError('POSTED_AMOUNT_CHANGED', 409);
      return 'posted';
    }
    if (complete) await tx.update(paypalTransactions).set({ status: 'posted', fee_ore: receipt.feeOre,
      net_ore: receipt.netOre, observed_at: record.observed_at }).where(eq(paypalTransactions.id, prior.id));
    if (!complete) return 'net_unresolved';
    await tx.insert(paypalPostings).values([
      { environment: scope.environment, merchant_id: scope.merchantId, provider_transaction_id: receipt.transactionId,
        posting_kind: 'gross', source_id: receipt.transactionId, intent_id: scope.intentId, user_id: scope.userId,
        amount_ore: receipt.grossOre, currency: 'DKK', effective_at: receipt.effectiveAt, verification },
      { environment: scope.environment, merchant_id: scope.merchantId, provider_transaction_id: receipt.transactionId,
        posting_kind: 'fee', source_id: receipt.transactionId, intent_id: scope.intentId, user_id: scope.userId,
        amount_ore: -receipt.feeOre!, currency: 'DKK', effective_at: receipt.effectiveAt, verification },
    ]).onConflictDoNothing();
    return 'posted';
  });
  return { status: outcome };
}

export async function postCaptureRefund(scope: Scope, originalCaptureId: string, refund: Refund, verification: string) {
  const outcome = await db.transaction(async (tx) => {
    const [original] = await tx.select().from(paypalTransactions).where(and(
      eq(paypalTransactions.environment, scope.environment), eq(paypalTransactions.merchant_id, scope.merchantId),
      eq(paypalTransactions.provider_transaction_id, originalCaptureId), eq(paypalTransactions.provider_kind, 'capture'))).for('update');
    if (!original || original.intent_id !== scope.intentId) throw new PayPalError('ORIGINAL_RECEIPT_MISSING', 409);
    const complete = refund.feeCreditOre !== null && refund.netDebitOre !== null;
    const record = { environment: scope.environment, merchant_id: scope.merchantId, provider_transaction_id: refund.transactionId,
      provider_kind: 'refund', original_transaction_id: originalCaptureId, intent_id: scope.intentId, user_id: scope.userId,
      status: 'net_unresolved', currency: 'DKK', gross_ore: refund.grossOre, fee_ore: refund.feeCreditOre,
      net_ore: refund.netDebitOre, effective_at: refund.effectiveAt, observed_at: new Date() };
    await tx.insert(paypalTransactions).values(record).onConflictDoNothing();
    const [prior] = await tx.select().from(paypalTransactions).where(and(
      eq(paypalTransactions.environment, scope.environment), eq(paypalTransactions.merchant_id, scope.merchantId),
      eq(paypalTransactions.provider_transaction_id, refund.transactionId))).for('update');
    if (!prior || prior.provider_kind !== 'refund' || prior.original_transaction_id !== originalCaptureId || prior.gross_ore !== refund.grossOre)
      throw new PayPalError('TRANSACTION_CONFLICT', 409);
    if (prior.status === 'posted') {
      if (complete && (prior.fee_ore !== refund.feeCreditOre || prior.net_ore !== refund.netDebitOre))
        throw new PayPalError('POSTED_AMOUNT_CHANGED', 409);
      return 'posted';
    }
    const [{ refunded }] = await tx.select({ refunded: sql<number>`coalesce(sum(${-1} * ${paypalPostings.amount_ore}), 0)::int` })
      .from(paypalPostings).where(and(eq(paypalPostings.environment, scope.environment),
        eq(paypalPostings.merchant_id, scope.merchantId), eq(paypalPostings.original_transaction_id, originalCaptureId),
        eq(paypalPostings.posting_kind, 'refund')));
    if (refunded + refund.grossOre > original.gross_ore!) throw new PayPalError('REFUND_EXCEEDS_RECEIPT', 409);
    if (complete && prior.status !== 'posted') await tx.update(paypalTransactions).set({ status: 'posted',
      fee_ore: refund.feeCreditOre, net_ore: refund.netDebitOre, observed_at: new Date() }).where(eq(paypalTransactions.id, prior.id));
    if (!complete) return 'net_unresolved';
    await tx.insert(paypalPostings).values([
      { environment: scope.environment, merchant_id: scope.merchantId, provider_transaction_id: refund.transactionId,
        posting_kind: 'refund', source_id: refund.transactionId, original_transaction_id: originalCaptureId,
        intent_id: scope.intentId, user_id: scope.userId, amount_ore: -refund.grossOre, currency: 'DKK',
        effective_at: refund.effectiveAt, verification },
      { environment: scope.environment, merchant_id: scope.merchantId, provider_transaction_id: refund.transactionId,
        posting_kind: 'fee_credit', source_id: refund.transactionId, original_transaction_id: originalCaptureId,
        intent_id: scope.intentId, user_id: scope.userId, amount_ore: refund.feeCreditOre!, currency: 'DKK',
        effective_at: refund.effectiveAt, verification },
    ]).onConflictDoNothing();
    return 'posted';
  });
  return { status: outcome };
}
