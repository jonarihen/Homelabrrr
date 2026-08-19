// Regression coverage for the redaction primitives. Deciding *whether* a
// message may skip redaction is not this module's job — that lives in
// utils/httpError.js (isPortalAuthoredError) and is tested there.
// Run with:  node --test src/utils/sanitize.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeError, redactUpstream, decodeHtmlEntities } from './sanitize.ts';

test('the long-standing string call shape is unchanged', () => {
  assert.equal(sanitizeError('cannot reach 192.168.1.10'), 'cannot reach [internal-host]');
  assert.equal(sanitizeError('cannot reach 192.168.1.10:8006'), 'cannot reach [internal-host]');
  assert.equal(
    sanitizeError('fetch https://10.0.0.5:8006/api2/json/nodes failed'),
    'fetch [proxmox-api] failed',
  );
  assert.equal(sanitizeError(''), 'Internal server error');
  assert.equal(sanitizeError(null), 'Internal server error');
  assert.equal(sanitizeError(undefined), 'Internal server error');
});

test('sanitizeError always redacts, whatever the error claims about itself', () => {
  // ~90 call sites still pass err.message. None of them may leak an address,
  // and a status on the error is not this module's business.
  const err = Object.assign(new Error('Proxmox GET /nodes → 500: cannot reach 10.0.0.5:8006'), { status: 400 });
  assert.doesNotMatch(sanitizeError(err.message), /10\.0\.0\.5/);
  assert.match(sanitizeError(err.message), /\[internal-host\]/);
});

test('redactUpstream redacts without the fallback string', () => {
  // upstreamError.js interpolates caller-supplied labels through this, so an
  // empty label must stay empty rather than becoming "Internal server error".
  assert.equal(redactUpstream('10.0.0.5'), '[internal-host]');
  assert.equal(redactUpstream(''), '');
  assert.equal(redactUpstream(null), '');
  assert.equal(redactUpstream(undefined), '');
  assert.equal(redactUpstream(123), '123');
});

test('decodeHtmlEntities still decodes FortiOS escaping', () => {
  assert.equal(
    decodeHtmlEntities('Return code -4 &#40;reached the maximum number of entries&#41;'),
    'Return code -4 (reached the maximum number of entries)',
  );
  assert.equal(decodeHtmlEntities('&amp;#40;'), '&#40;');
  assert.equal(decodeHtmlEntities(''), '');
});
