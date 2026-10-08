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
export function normalizeCompletedCapture(capture: any, expected: { orderId: string; merchantId: string; amountOre: number }) {
  if (!capture || capture.status !== 'COMPLETED' || typeof capture.id !== 'string' ||
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
