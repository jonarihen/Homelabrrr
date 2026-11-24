// Coverage for which support methods a member sees and whether the
// "Support the lab" entry shows at all.
//
// Run with:  node --test src/utils/supportStatus.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { supportMethods, supportVisible } from './supportStatus.js';

const allOff = { configured: true, checkoutEnabled: false, kofi: { enabled: false, pageUrl: null }, bankTransfer: { enabled: false } };

test('supportMethods reads each switch from the status answer', () => {
  assert.deepEqual(supportMethods(allOff), { paypal: false, kofi: false, bankTransfer: false });
  assert.deepEqual(supportMethods({ ...allOff, checkoutEnabled: true }), { paypal: true, kofi: false, bankTransfer: false });
  assert.deepEqual(supportMethods({ ...allOff, kofi: { enabled: true, pageUrl: 'https://ko-fi.com/x' } }), { paypal: false, kofi: true, bankTransfer: false });
  assert.deepEqual(supportMethods({ ...allOff, bankTransfer: { enabled: true } }), { paypal: false, kofi: false, bankTransfer: true });
});

test('PayPal counts only when checkout is enabled, not when merely configured', () => {
  assert.equal(supportMethods({ configured: true, checkoutEnabled: false }).paypal, false);
  assert.equal(supportMethods({ configured: true, checkoutEnabled: 'yes' }).paypal, false);
});

test('a status answer without the bank transfer block treats bank transfer as enabled', () => {
  assert.equal(supportMethods({ checkoutEnabled: false }).bankTransfer, true);
  assert.equal(supportMethods({ checkoutEnabled: false, bankTransfer: {} }).bankTransfer, true);
  assert.equal(supportMethods({ checkoutEnabled: false, bankTransfer: null }).bankTransfer, true);
});

test('no status means no methods and no entry', () => {
  for (const missing of [null, undefined, [], '', 'nope', 0]) {
    assert.deepEqual(supportMethods(missing), { paypal: false, kofi: false, bankTransfer: false });
    assert.equal(supportVisible(missing), false);
  }
});

test('supportVisible follows the server answer when it gives one', () => {
  // Every method off, but the member still has a subscription to manage.
  assert.equal(supportVisible({ ...allOff, showSupport: true }), true);
  assert.equal(supportVisible({ checkoutEnabled: true, showSupport: false }), false);
});

test('supportVisible falls back to the method switches for an older answer', () => {
  assert.equal(supportVisible(allOff), false);
  assert.equal(supportVisible({ ...allOff, checkoutEnabled: true }), true);
  assert.equal(supportVisible({ ...allOff, kofi: { enabled: true } }), true);
  assert.equal(supportVisible({ ...allOff, bankTransfer: { enabled: true } }), true);
  assert.equal(supportVisible({ checkoutEnabled: false }), true, 'missing bank transfer block counts as enabled');
  assert.equal(supportVisible({ ...allOff, showSupport: 'true' }), false, 'a non-boolean showSupport is ignored');
});
