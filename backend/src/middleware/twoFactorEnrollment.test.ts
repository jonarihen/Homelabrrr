import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceTwoFactorEnrollmentOnly } from './twoFactorEnrollment.ts';

function invoke(path) {
  let nextCalled = false;
  let response = null;
  const res = {
    status(status) { response = { status }; return this; },
    json(body) { response.body = body; return this; },
  };
  enforceTwoFactorEnrollmentOnly(
    { path, session: { twoFactorEnrollmentOnly: true } },
    res,
    () => { nextCalled = true; },
  );
  return { nextCalled, response };
}

test('forced enrollment permits reauthentication but blocks unrelated routes', () => {
  assert.equal(invoke('/api/auth/reauthenticate').nextCalled, true);
  assert.equal(invoke('/api/auth/2fa/setup').nextCalled, true);
  assert.equal(invoke('/api/admin/users').response.status, 403);
});
