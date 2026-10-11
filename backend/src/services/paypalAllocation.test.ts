import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const { allocateMonth, allocationMonth } = await import('./paypalAllocation.ts');

test('confirmed net credit is applied once and surplus carries forward', () => {
  const month = allocateMonth(0, 9600, 100_000);
  assert.deepEqual(month, { status: 'known', appliedOre: 9600, ownerRemainderOre: 90_400,
    ownerAdjustmentOre: 0, closingBalanceOre: 0 });
  assert.deepEqual(allocateMonth(0, 120_000, 100_000), { status: 'known', appliedOre: 100_000,
    ownerRemainderOre: 0, ownerAdjustmentOre: 0, closingBalanceOre: 20_000 });
  assert.equal(allocateMonth(20_000, 0, 10_000).closingBalanceOre, 10_000);
});
test('late refund creates an owner-funded adjustment, never donor debt', () => {
  const refunded = allocateMonth(0, -10_000, 5_000);
  assert.deepEqual(refunded, { status: 'known', appliedOre: 0, ownerRemainderOre: 5000,
    ownerAdjustmentOre: 10_000, closingBalanceOre: -10_000 });
  assert.deepEqual(allocateMonth(-10_000, 20_000, 5000), { status: 'known', appliedOre: 5000,
    ownerRemainderOre: 0, ownerAdjustmentOre: 0, closingBalanceOre: 5000 });
});
test('unresolved net and unknown costs cannot fabricate an owner remainder', () => {
  assert.equal(allocateMonth(0, 5000, 10_000, 1).status, 'unresolved');
  assert.equal(allocateMonth(0, 5000, 10_000, 1).appliedOre, null);
  assert.equal(allocateMonth(0, 5000, null).ownerRemainderOre, null);
  assert.equal(allocateMonth(0, 5000, null).closingBalanceOre, null);
  assert.equal(allocateMonth(allocateMonth(0, 5000, null).closingBalanceOre, 0, 10_000).status, 'unresolved');
  assert.equal(allocateMonth(0, 5000, -100).status, 'cost_unknown');
  assert.equal(allocateMonth(0, 5000, 0).appliedOre, 0);
});
test('receipt month uses Copenhagen local calendar across DST boundaries', () => {
  assert.equal(allocationMonth(new Date('2026-10-31T23:30:00Z')), '2026-11');
  assert.equal(allocationMonth(new Date('2026-03-31T21:30:00Z')), '2026-03');
});
