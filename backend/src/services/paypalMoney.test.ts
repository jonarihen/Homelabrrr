import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDkkOre, oreToDkk, normalizeCompletedCapture, normalizeSubscriptionTransaction, normalizeCaptureRefund, normalizeReportedAdjustment } from './paypalMoney.ts';

const expected = { orderId: 'ORDER123', merchantId: 'MERCHANT123', amountOre: 10000 };
function capture(overrides: any = {}) { return { id: 'CAPTURE123', status: 'COMPLETED', payee: { merchant_id: 'MERCHANT123' },
  supplementary_data: { related_ids: { order_id: 'ORDER123' } }, amount: { currency_code: 'DKK', value: '100.00' },
  seller_receivable_breakdown: { gross_amount: { currency_code: 'DKK', value: '100.00' }, paypal_fee: { currency_code: 'DKK', value: '4.00' },
    net_amount: { currency_code: 'DKK', value: '96.00' } }, create_time: '2026-10-08T00:00:00Z', ...overrides }; }
test('DKK parsing uses exact ore and rejects unsafe values', () => {
  assert.equal(parseDkkOre('5'), 500); assert.equal(parseDkkOre('100.25'), 10025); assert.equal(oreToDkk(10025), '100.25');
  for (const bad of ['0', '-1', '1.234', '1000.001', '1001', '1e2']) assert.throws(() => parseDkkOre(bad));
});
test('verified capture uses actual fee and net without a second deduction', () => {
  assert.deepEqual(normalizeCompletedCapture(capture(), expected), { transactionId: 'CAPTURE123', grossOre: 10000,
    feeOre: 400, netOre: 9600, effectiveAt: new Date('2026-10-08T00:00:00Z') });
  assert.throws(() => normalizeCompletedCapture(capture({ payee: { merchant_id: 'WRONG' } }), expected), /CAPTURE_MISMATCH/);
  assert.throws(() => normalizeCompletedCapture(capture({ status: 'PENDING' }), expected), /CAPTURE_MISMATCH/);
  assert.equal(normalizeCompletedCapture(capture({ status: 'REFUNDED' }), expected).grossOre, 10000);
});
test('missing fee remains unknown and cannot become known net', () => {
  const value = capture(); delete value.seller_receivable_breakdown.paypal_fee;
  assert.equal(normalizeCompletedCapture(value, expected).feeOre, null);
});

test('subscription installments use actual fee and never treat pending as receipt', () => {
  const { normalizeSubscriptionTransaction } = requireMoney();
  const entry = { id: 'SALE123', status: 'COMPLETED', time: '2026-10-08T12:00:00Z', amount_with_breakdown: {
    gross_amount: { currency_code: 'DKK', value: '100.00' }, fee_amount: { currency_code: 'DKK', value: '4.00' },
    net_amount: { currency_code: 'DKK', value: '96.00' } } };
  assert.deepEqual(normalizeSubscriptionTransaction(entry, { amountOre: 10000 }), { transactionId: 'SALE123', grossOre: 10000,
    feeOre: 400, netOre: 9600, effectiveAt: new Date('2026-10-08T12:00:00Z'), status: 'COMPLETED' });
  assert.equal(normalizeSubscriptionTransaction({ ...entry, status: 'PENDING' }, { amountOre: 10000 }), null);
  assert.equal(normalizeSubscriptionTransaction({ ...entry, status: 'REFUNDED' }, { amountOre: 10000 })?.grossOre, 10000);
  assert.throws(() => normalizeSubscriptionTransaction(entry, { amountOre: 9000 }), /SALE_AMOUNT_MISMATCH/);
});
test('refund fee credit is actual and cumulative refunded amount is ignored', () => {
  const { normalizeCaptureRefund } = requireMoney();
  const entry = { id: 'REFUND123', status: 'COMPLETED', amount: { currency_code: 'DKK', value: '20.00' },
    seller_payable_breakdown: { gross_amount: { currency_code: 'DKK', value: '20.00' },
      paypal_fee: { currency_code: 'DKK', value: '0.50' }, net_amount: { currency_code: 'DKK', value: '19.50' },
      total_refunded_amount: { currency_code: 'DKK', value: '40.00' } }, create_time: '2026-10-08T13:00:00Z' };
  assert.deepEqual(normalizeCaptureRefund(entry), { transactionId: 'REFUND123', grossOre: 2000, feeCreditOre: 50,
    netDebitOre: 1950, effectiveAt: new Date('2026-10-08T13:00:00Z') });
  assert.equal(normalizeCaptureRefund({ ...entry, status: 'PENDING' }), null);
  const missingFee = { ...entry, seller_payable_breakdown: { ...entry.seller_payable_breakdown, paypal_fee: undefined } };
  assert.equal(normalizeCaptureRefund(missingFee)?.feeCreditOre, null);
});
function requireMoney() { return { normalizeSubscriptionTransaction, normalizeCaptureRefund }; }
test('reporting adjustment requires a linked, successful negative DKK transaction', () => {
  const detail = { transaction_info: { transaction_id: 'RF123', paypal_reference_id: 'SALE123',
    paypal_reference_id_type: 'TXN', transaction_event_code: 'T1107', transaction_status: 'S',
    transaction_amount: { currency_code: 'DKK', value: '-20.00' }, fee_amount: { currency_code: 'DKK', value: '0.50' },
    transaction_initiation_date: '2026-10-08T13:00:00Z' } };
  assert.deepEqual(normalizeReportedAdjustment(detail, 'RF123', 'refund'), { transactionId: 'RF123',
    originalTransactionId: 'SALE123', grossOre: 2000, feeCreditOre: 50, netDebitOre: 1950,
    effectiveAt: new Date('2026-10-08T13:00:00Z') });
  assert.throws(() => normalizeReportedAdjustment(detail, 'OTHER', 'refund'), /ADJUSTMENT_MISMATCH/);
  assert.throws(() => normalizeReportedAdjustment({ transaction_info: { ...detail.transaction_info,
    transaction_amount: { currency_code: 'USD', value: '-20.00' } } }, 'RF123', 'refund'), /ADJUSTMENT_AMOUNT_UNKNOWN/);
  assert.equal(normalizeReportedAdjustment({ transaction_info: { ...detail.transaction_info, fee_amount: undefined } }, 'RF123', 'refund').netDebitOre, null);
});
