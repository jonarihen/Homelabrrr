// Regression coverage for HTTP error status resolution and body building.
// Run with:  node --test src/utils/httpError.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveErrorStatus, hasHttpStatus, errorPayload, sendError, httpError, tagStatus,
} from './httpError.js';

const withStatusCode = (code, message = 'boom') => Object.assign(new Error(message), { statusCode: code });
const withStatus = (code, message = 'boom') => Object.assign(new Error(message), { status: code });

// Minimal Express-ish response recorder.
function fakeRes() {
  const calls = { status: null, body: null };
  return {
    calls,
    status(code) { calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
  };
}

test('resolveErrorStatus honours statusCode', () => {
  assert.equal(resolveErrorStatus(withStatusCode(400)), 400);
  assert.equal(resolveErrorStatus(withStatusCode(403)), 403);
  assert.equal(resolveErrorStatus(withStatusCode(503)), 503);
});

test('resolveErrorStatus honours status as an alias', () => {
  assert.equal(resolveErrorStatus(withStatus(400)), 400);
  assert.equal(resolveErrorStatus(withStatus(403)), 403);
  assert.equal(resolveErrorStatus(withStatus(423)), 423);
});

test('statusCode wins when both are set and disagree', () => {
  const err = Object.assign(new Error('boom'), { statusCode: 400, status: 403 });
  assert.equal(resolveErrorStatus(err), 400);
});

test('an untagged error is a 500', () => {
  assert.equal(resolveErrorStatus(new Error('upstream exploded')), 500);
});

test('implausible status values fall back rather than leaking through', () => {
  // A 2xx must never be used to report a failure.
  assert.equal(resolveErrorStatus(withStatusCode(200)), 500);
  assert.equal(resolveErrorStatus(withStatusCode(0)), 500);
  assert.equal(resolveErrorStatus(withStatusCode(700)), 500);
  assert.equal(resolveErrorStatus(withStatusCode(404.5)), 500);
  assert.equal(resolveErrorStatus(withStatusCode(Number.NaN)), 500);
  // Proxmox/FortiGate payloads carry a textual `status` ("running", "OK") —
  // that must not be mistaken for an HTTP status.
  assert.equal(resolveErrorStatus(withStatus('running')), 500);
  assert.equal(resolveErrorStatus(withStatus('')), 500);
  // A numeric string is still a usable status.
  assert.equal(resolveErrorStatus(withStatus('403')), 403);
  // Garbage statusCode falls through to a usable status.
  assert.equal(resolveErrorStatus(Object.assign(new Error('x'), { statusCode: 200, status: 403 })), 403);
});

test('non-Error throwables resolve to 500', () => {
  assert.equal(resolveErrorStatus('just a string'), 500);
  assert.equal(resolveErrorStatus(undefined), 500);
  assert.equal(resolveErrorStatus(null), 500);
  assert.equal(resolveErrorStatus(42), 500);
});

test('hasHttpStatus detects either property', () => {
  assert.equal(hasHttpStatus(withStatusCode(400)), true);
  assert.equal(hasHttpStatus(withStatus(403)), true);
  assert.equal(hasHttpStatus(new Error('plain')), false);
  assert.equal(hasHttpStatus(withStatus('running')), false);
  assert.equal(hasHttpStatus('a string'), false);
  assert.equal(hasHttpStatus(undefined), false);
  assert.equal(hasHttpStatus(Object.assign(withStatusCode(404), { expose: false })), false);
});

test('an upstream-reflected status is never forwarded to the browser', () => {
  // fortigate.js/caddy.js copy the *remote* status onto the error. Forwarding a
  // FortiGate 401 would trip the frontend's "401 ⇒ /login" interceptor and sign
  // the user out because a firewall API key is wrong.
  for (const code of [401, 403, 404, 429]) {
    const err = Object.assign(new Error(`FortiGate API error: HTTP ${code}`), {
      statusCode: code,
      expose: false,
    });
    assert.equal(resolveErrorStatus(err), 500, `upstream ${code} is reported as 500`);
  }
});

// ─── Payload building ────────────────────────────────────────────────────────

test('a 4xx message keeps an IPv4 literal verbatim', () => {
  const err = httpError(400, 'No DHCP server was found on 10.20.30.40 for vlan1008');
  assert.deepEqual(errorPayload(err), {
    error: 'No DHCP server was found on 10.20.30.40 for vlan1008',
  });
});

test('a 500 message still has its IPv4 literal redacted', () => {
  const err = new Error('connect ECONNREFUSED 10.20.30.40:8006');
  assert.deepEqual(errorPayload(err), { error: 'connect ECONNREFUSED [internal-host]' });
});

test('a 5xx message is sanitized even when explicitly tagged', () => {
  const err = httpError(503, 'Proxmox 10.0.0.1 is unreachable');
  assert.deepEqual(errorPayload(err), { error: 'Proxmox [internal-host] is unreachable' });
});

test('expose:false keeps an upstream 4xx message sanitized', () => {
  // fortigate.js / caddy.js reflect the remote status onto the error — their
  // text is upstream output, not portal copy, so it must still be scrubbed.
  const err = Object.assign(new Error('FortiGate API error: duplicate address 10.20.30.40'), {
    statusCode: 400,
    expose: false,
  });
  assert.deepEqual(errorPayload(err), {
    error: 'FortiGate API error: duplicate address [internal-host]',
  });
  // Belt and braces: sanitized even if a caller forces a 4xx by hand.
  assert.deepEqual(errorPayload(err, 400), {
    error: 'FortiGate API error: duplicate address [internal-host]',
  });
});

test('non-Error throwables produce a usable body', () => {
  assert.deepEqual(errorPayload('raw string failure'), { error: 'raw string failure' });
  assert.deepEqual(errorPayload(undefined), { error: 'Internal server error' });
  assert.deepEqual(errorPayload(new Error('')), { error: 'Internal server error' });
  // A 4xx with no message must not come back empty.
  assert.deepEqual(errorPayload(httpError(400, '')), { error: 'Request failed' });
});

// ─── sendError ───────────────────────────────────────────────────────────────

test('sendError writes status and body together', () => {
  const res = fakeRes();
  sendError(res, httpError(400, 'Network interface net0 is not VLAN-tagged'));
  assert.equal(res.calls.status, 400);
  assert.deepEqual(res.calls.body, { error: 'Network interface net0 is not VLAN-tagged' });
});

test('sendError falls back to a sanitized 500 for unknown failures', () => {
  const res = fakeRes();
  sendError(res, new Error('Proxmox GET https://10.0.0.5/api2/json/nodes → 500: nope'));
  assert.equal(res.calls.status, 500);
  assert.equal(res.calls.body.error.includes('10.0.0.5'), false);
});

test('sendError honours the status alias used by capacity/quota helpers', () => {
  const res = fakeRes();
  sendError(res, withStatus(403, 'Quota exceeded: 8 cores requested, 2 remaining'));
  assert.equal(res.calls.status, 403);
  assert.deepEqual(res.calls.body, { error: 'Quota exceeded: 8 cores requested, 2 remaining' });
});

// ─── Factories ───────────────────────────────────────────────────────────────

test('httpError and tagStatus set both property names', () => {
  const err = httpError(400, 'nope');
  assert.equal(err.statusCode, 400);
  assert.equal(err.status, 400);
  assert.ok(err instanceof Error);

  const tagged = tagStatus(new Error('locked'), 423);
  assert.equal(tagged.statusCode, 423);
  assert.equal(tagged.status, 423);
});
