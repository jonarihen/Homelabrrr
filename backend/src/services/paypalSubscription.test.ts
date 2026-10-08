import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSubscriptionIdentity, isTerminalSubscriptionStatus } from './paypal.ts';

test('only confirmed terminal PayPal states permit member deletion', () => {
  assert.equal(isTerminalSubscriptionStatus('CANCELLED'), true);
  assert.equal(isTerminalSubscriptionStatus('EXPIRED'), true);
  for (const status of ['ACTIVE', 'APPROVAL_PENDING', 'APPROVED', 'SUSPENDED', 'CANCELLATION_REQUESTED', 'UNKNOWN'])
    assert.equal(isTerminalSubscriptionStatus(status), false);
});
test('cancellation readback must stay bound to the locally created subscription', () => {
  const local = { id: 'SUB123', plan_id: 'PLAN123', intent_id: 'intent-123' };
  assert.doesNotThrow(() => assertSubscriptionIdentity({ id: 'SUB123', plan_id: 'PLAN123', custom_id: 'intent-123' }, local));
  assert.throws(() => assertSubscriptionIdentity({ id: 'SUB123', plan_id: 'OTHER', custom_id: 'intent-123' }, local), /SUBSCRIPTION_MISMATCH/);
  assert.throws(() => assertSubscriptionIdentity({ id: 'SUB123', plan_id: 'PLAN123', custom_id: 'other-intent' }, local), /SUBSCRIPTION_MISMATCH/);
});
