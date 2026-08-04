import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOrigin, csrfProtection, requestOriginAllowed } from './requestSecurity.js';

test('canonicalOrigin accepts origins but rejects URLs with paths', () => {
  assert.equal(canonicalOrigin('https://portal.example.com'), 'https://portal.example.com');
  assert.equal(canonicalOrigin('https://portal.example.com/path'), '');
});

test('configured origin is authoritative', () => {
  assert.equal(requestOriginAllowed({ origin: 'https://portal.example.com', allowedOrigin: 'https://portal.example.com', protocol: 'http', host: 'internal' }), true);
  assert.equal(requestOriginAllowed({ origin: 'https://evil.example.com', allowedOrigin: 'https://portal.example.com', protocol: 'https', host: 'portal.example.com' }), false);
});

test('reverse-proxy same-origin fallback accepts the external protocol and host', () => {
  assert.equal(requestOriginAllowed({ origin: 'https://portal.example.com', allowedOrigin: '', protocol: 'https', host: 'portal.example.com' }), true);
  assert.equal(requestOriginAllowed({ origin: 'https://sibling.example.com', allowedOrigin: '', protocol: 'https', host: 'portal.example.com' }), false);
  assert.equal(requestOriginAllowed({ origin: '', allowedOrigin: '', protocol: 'https', host: 'portal.example.com' }), false);
});

test('cookie mutations fail closed while bearer-token mutations bypass browser CSRF', () => {
  const middleware = csrfProtection({ allowedOrigin: 'https://portal.example.com' });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalls = 0;
  middleware({ method: 'POST', headers: {}, protocol: 'https', get: () => 'portal.example.com' }, response, () => { nextCalls += 1; });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'ORIGIN_NOT_ALLOWED');
  middleware({ method: 'POST', headers: {}, apiToken: { id: 1 }, protocol: 'http', get: () => 'internal' }, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});
