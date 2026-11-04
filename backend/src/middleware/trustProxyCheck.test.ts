import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warnIfInsecureWithSecureCookies } from './trustProxyCheck.ts';

test('warns once about plain HTTP when secure cookies are on', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  delete process.env.COOKIE_SECURE;
  assert.equal(warnIfInsecureWithSecureCookies({ secure: true }), false);
  assert.equal(warnIfInsecureWithSecureCookies({ secure: false }), true);
  assert.equal(warnIfInsecureWithSecureCookies({ secure: false }), false);
  assert.equal(warn.mock.callCount(), 1);
});
