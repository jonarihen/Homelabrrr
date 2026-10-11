import test from 'node:test';
import assert from 'node:assert/strict';
// The helpers are pure, but the module imports the shared DB pool. The URL is
// deliberately unreachable; these tests never connect to it.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const { assertSubscriptionIdentity, isTerminalSubscriptionStatus, paypalInboxRetryDelayMs } = await import('./paypal.ts');

test('only confirmed terminal PayPal states permit member deletion', () => {
  assert.equal(isTerminalSubscriptionStatus('CANCELLED'), true);
  assert.equal(isTerminalSubscriptionStatus('EXPIRED'), true);
  for (const status of ['ACTIVE', 'APPROVAL_PENDING', 'APPROVED', 'SUSPENDED', 'CANCELLATION_REQUESTED', 'UNKNOWN'])
    assert.equal(isTerminalSubscriptionStatus(status), false);
});
test('inbox retries are bounded and leave permanent failures for review', () => {
  assert.equal(paypalInboxRetryDelayMs(1), 5 * 60_000);
  assert.equal(paypalInboxRetryDelayMs(2), 10 * 60_000);
  assert.equal(paypalInboxRetryDelayMs(20), 6 * 60 * 60_000);
});
test('cancellation readback must stay bound to the locally created subscription', () => {
  const local = { id: 'SUB123', plan_id: 'PLAN123', intent_id: 'intent-123' };
  assert.doesNotThrow(() => assertSubscriptionIdentity({ id: 'SUB123', plan_id: 'PLAN123', custom_id: 'intent-123' }, local));
  assert.throws(() => assertSubscriptionIdentity({ id: 'SUB123', plan_id: 'OTHER', custom_id: 'intent-123' }, local), /SUBSCRIPTION_MISMATCH/);
  assert.throws(() => assertSubscriptionIdentity({ id: 'SUB123', plan_id: 'PLAN123', custom_id: 'other-intent' }, local), /SUBSCRIPTION_MISMATCH/);
});
