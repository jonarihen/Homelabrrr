import { PayPalError } from './paypalClient.ts';

export function parseDkkOre(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) throw new PayPalError('INVALID_AMOUNT', 400);
  const [whole, fraction = ''] = value.split('.');
  const ore = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (ore < 500 || ore > 100_000) throw new PayPalError('AMOUNT_OUT_OF_RANGE', 400);
  return ore;
}
export function oreToDkk(ore: number): string { return `${Math.floor(ore / 100)}.${String(ore % 100).padStart(2, '0')}`; }
export function providerOre(amount: any): number | null {
  if (!amount || amount.currency_code !== 'DKK' || typeof amount.value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(amount.value)) return null;
  const [whole, fraction = ''] = amount.value.split('.');
  const ore = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(ore) ? ore : null;
}
export function providerSignedOre(amount: any): number | null {
  if (!amount || amount.currency_code !== 'DKK' || typeof amount.value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(amount.value)) return null;
  const sign = amount.value.startsWith('-') ? -1 : 1;
  const [whole, fraction = ''] = amount.value.replace(/^-/, '').split('.');
  const ore = sign * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
  return Number.isSafeInteger(ore) ? ore : null;
}
export function normalizeReportedAdjustment(detail: any, expectedId: string, kind: 'refund' | 'reversal') {
  const info = detail?.transaction_info;
  const codes = kind === 'refund' ? ['T1107'] : ['T1100', 'T1118'];
  if (info?.transaction_id !== expectedId || info?.paypal_reference_id_type !== 'TXN' ||
      typeof info.paypal_reference_id !== 'string' || !codes.includes(info.transaction_event_code))
    throw new PayPalError('ADJUSTMENT_MISMATCH', 409);
  if (info.transaction_status === 'P') throw new PayPalError('ADJUSTMENT_NOT_READY', 409);
  if (info.transaction_status !== 'S') throw new PayPalError('ADJUSTMENT_MISMATCH', 409);
  const signedGross = providerSignedOre(info.transaction_amount);
  const feeCredit = providerSignedOre(info.fee_amount);
  if (signedGross === null || signedGross >= 0 || feeCredit !== null && feeCredit < 0)
    throw new PayPalError('ADJUSTMENT_AMOUNT_UNKNOWN', 409);
  const effectiveAt = new Date(info.transaction_initiation_date || info.transaction_updated_date);
  if (!Number.isFinite(effectiveAt.getTime())) throw new PayPalError('MALFORMED', 409);
  return { transactionId: expectedId, originalTransactionId: info.paypal_reference_id,
    grossOre: -signedGross, feeCreditOre: feeCredit, netDebitOre: feeCredit === null ? null : -signedGross - feeCredit,
    effectiveAt };
}
export function normalizeCompletedCapture(capture: any, expected: { orderId: string; merchantId: string; amountOre: number }) {
  if (!capture || !['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(capture.status) || typeof capture.id !== 'string' ||
    capture.payee?.merchant_id !== expected.merchantId ||
    capture.supplementary_data?.related_ids?.order_id !== expected.orderId ||
    providerOre(capture.amount) !== expected.amountOre) throw new PayPalError('CAPTURE_MISMATCH', 409);
  const breakdown = capture.seller_receivable_breakdown;
  const gross = providerOre(breakdown?.gross_amount);
  const fee = providerOre(breakdown?.paypal_fee);
  const net = providerOre(breakdown?.net_amount);
  if (gross !== null && gross !== expected.amountOre) throw new PayPalError('CAPTURE_MISMATCH', 409);
  if (fee !== null && net !== null && gross !== null && gross - fee !== net) throw new PayPalError('BREAKDOWN_MISMATCH', 409);
  const effectiveAt = new Date(capture.create_time || capture.update_time);
  if (!Number.isFinite(effectiveAt.getTime())) throw new PayPalError('MALFORMED');
  return { transactionId: capture.id, grossOre: expected.amountOre, feeOre: fee, netOre: net, effectiveAt };
}

export function normalizeSubscriptionTransaction(transaction: any, expected: { amountOre: number }) {
  if (!transaction || typeof transaction.id !== 'string' ||
      !['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(transaction.status)) return null;
  const breakdown = transaction.amount_with_breakdown;
  const gross = providerOre(breakdown?.gross_amount);
  const fee = providerOre(breakdown?.fee_amount);
  const net = providerOre(breakdown?.net_amount);
  if (gross !== expected.amountOre) throw new PayPalError('SALE_AMOUNT_MISMATCH', 409);
  if (fee !== null && net !== null && gross - fee !== net) throw new PayPalError('BREAKDOWN_MISMATCH', 409);
  const effectiveAt = new Date(transaction.time);
  if (!Number.isFinite(effectiveAt.getTime())) throw new PayPalError('MALFORMED');
  return { transactionId: transaction.id, grossOre: gross, feeOre: fee, netOre: net, effectiveAt, status: transaction.status };
}

export function normalizeCaptureRefund(refund: any) {
  if (!refund || refund.status !== 'COMPLETED' || typeof refund.id !== 'string') return null;
  const gross = providerOre(refund.amount);
  const payable = refund.seller_payable_breakdown;
  const refundedFee = providerOre(payable?.paypal_fee);
  const netDebit = providerOre(payable?.net_amount);
  if (gross === null || gross <= 0 || providerOre(payable?.gross_amount) !== gross) throw new PayPalError('REFUND_AMOUNT_MISMATCH', 409);
  if (refundedFee !== null && netDebit !== null && gross - refundedFee !== netDebit) throw new PayPalError('BREAKDOWN_MISMATCH', 409);
  const effectiveAt = new Date(refund.create_time || refund.update_time);
  if (!Number.isFinite(effectiveAt.getTime())) throw new PayPalError('MALFORMED');
  return { transactionId: refund.id, grossOre: gross, feeCreditOre: refundedFee, netDebitOre: netDebit, effectiveAt };
}
