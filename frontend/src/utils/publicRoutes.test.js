// Regression coverage for the signed-out route list used by the api.js 401
// interceptor. Run with:  node --test src/utils/publicRoutes.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicPath } from './publicRoutes.js';

test('the invite redemption route is public', () => {
  // The bug: AuthProvider's /auth/me 401s for an invitee, the interceptor
  // redirected, and the invite page was replaced by the sign-in form.
  for (const p of [
    '/invite/abc123',
    '/invite/abc123/',
    `/invite/${'a'.repeat(43)}`,            // a real 32-byte base64url token
    '/invite/tok-en_with.url~safe-chars',
  ]) {
    assert.equal(isPublicPath(p), true, p);
  }
});

test('the login route stays public', () => {
  assert.equal(isPublicPath('/login'), true);
  assert.equal(isPublicPath('/login/'), true);
});

test('authenticated routes still redirect on 401', () => {
  for (const p of [
    '/',
    '/dashboard',
    '/welcome',
    '/account',
    '/admin/users',
    '/vm/host1~pve/101',
    '/invite',                              // the list page, not a redemption
    '/invite/',
    '/invite/abc/extra',                    // deeper path is not the invite page
    '/loginer',                             // must not prefix-match /login
    '/x/login',
  ]) {
    assert.equal(isPublicPath(p), false, p);
  }
});

test('a non-string pathname keeps the redirect behaviour', () => {
  for (const v of [undefined, null, 42, {}, ['/login']]) {
    assert.equal(isPublicPath(v), false, JSON.stringify(v));
  }
});
