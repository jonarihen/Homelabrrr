import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDkkOre, oreToDkk, normalizeCompletedCapture } from './paypalMoney.ts';

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
});
test('missing fee remains unknown and cannot become known net', () => {
  const value = capture(); delete value.seller_receivable_breakdown.paypal_fee;
  assert.equal(normalizeCompletedCapture(value, expected).feeOre, null);
});
