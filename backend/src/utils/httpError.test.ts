// Regression coverage for HTTP error status resolution and body building.
// Run with:  node --test src/utils/httpError.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveErrorStatus, hasHttpStatus, errorPayload, sendError, httpError, tagStatus,
  isPortalAuthoredError,
} from './httpError.ts';

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

// ─── Authorship: the one check that decides whether text is shown verbatim ───

test('an explicit 4xx marks an error as portal-authored, on either property', () => {
  for (const status of [400, 403, 404, 409, 423, 499]) {
    assert.equal(isPortalAuthoredError(withStatus(status)), true, `status ${status}`);
    assert.equal(isPortalAuthoredError(withStatusCode(status)), true, `statusCode ${status}`);
  }
});

test('the portal-side guards that already exist are recognised', () => {
  // Exactly the shapes utils/capacity.js, utils/quota.js, utils/cpuTopology.js,
  // utils/nodeMaintenance.js and utils/storageVisibility.js throw.
  const shapes = [
    Object.assign(new Error('capacity'), { status: 400 }),
    Object.assign(new Error('quota'), { status: 403 }),
    Object.assign(new Error('storage not exposed'), { status: 403 }),
    Object.assign(new Error('node in maintenance'), { status: 423 }),
    httpError(400, 'from the factory'),
  ];
  for (const err of shapes) assert.equal(isPortalAuthoredError(err), true, err.message);
});

test('expose:false beats a 4xx status — that is what makes statusCode safe to read', () => {
  // fortigate.js and utils/caddy.js reflect the *remote* status onto the error.
  // Reading statusCode is only sound because they opt out here.
  for (const code of [400, 401, 403, 404]) {
    const err = Object.assign(new Error('FortiGate API error'), { statusCode: code, expose: false });
    assert.equal(isPortalAuthoredError(err), false, String(code));
  }
});

test('nothing else counts as portal-authored', () => {
  for (const input of [null, undefined, '', 'a string', 42, {}, new Error('plain')]) {
    assert.equal(isPortalAuthoredError(input), false, String(input));
  }
  // A 5xx is upstream text until proven otherwise, and a non-status is not a status.
  assert.equal(isPortalAuthoredError(withStatus(503)), false);
  assert.equal(isPortalAuthoredError(withStatus('running')), false);
  assert.equal(isPortalAuthoredError(withStatus(200)), false);
  assert.equal(isPortalAuthoredError(withStatusCode(400.5)), false);
});

// ─── Payload building ────────────────────────────────────────────────────────

test('a 4xx message keeps an IPv4 literal verbatim', () => {
  const err = httpError(400, 'No DHCP server was found on 10.20.30.40 for vlan1008');
  assert.deepEqual(errorPayload(err), {
    error: 'No DHCP server was found on 10.20.30.40 for vlan1008',
  });
});

test('a 500 message never carries an IPv4 literal through', () => {
  // ECONNREFUSED is now a recognised failure, so the body is the translated
  // shape rather than the redacted string — but the address is gone either way,
  // which is the property that matters.
  const body = errorPayload(new Error('connect ECONNREFUSED 10.20.30.40:8006'));
  assert.doesNotMatch(JSON.stringify(body), /10\.20\.30\.40/);
  assert.match(body.title, /unreachable/i);
});

test('an unrecognised 500 message still comes back as the redacted string alone', () => {
  const err = new Error('Proxmox GET /nodes → 500: mystery at 10.20.30.40');
  assert.deepEqual(errorPayload(err), { error: 'Proxmox GET /nodes → 500: mystery at [internal-host]' });
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

// ─── Composition with the translation layer (utils/upstreamError.js) ─────────

test('a recognised upstream failure is answered in the portal\'s own words', () => {
  const res = fakeRes();
  sendError(res, new Error(
    'Proxmox POST /nodes/pve1/qemu/105/status/start → 500: '
    + '{"data":null,"errors":{"":"volume \'local-lvm:vm-105-disk-0\' does not exist"}}',
  ));
  assert.equal(res.calls.status, 500);
  assert.match(res.calls.body.title, /disk is missing/i);
  assert.match(res.calls.body.detail, /local-lvm/);
  assert.equal(typeof res.calls.body.action, 'string');
  // The legacy string field is always present for the unconverted call sites.
  assert.equal(typeof res.calls.body.error, 'string');
  // And the raw blob is not handed back.
  assert.doesNotMatch(JSON.stringify(res.calls.body), /api2|\{"data"/);
});

test('status resolution and translation compose: a tagged 503 still gets translated', () => {
  // The provisioning routes tag "globally unique VMID" failures 503; the body
  // is still built by the translation layer, not by a second helper.
  const err = tagStatus(new Error('Could not allocate a globally unique VMID: connect ECONNREFUSED 10.0.0.5:8006'), 503);
  const res = fakeRes();
  sendError(res, err);
  assert.equal(res.calls.status, 503);
  assert.match(res.calls.body.title, /unreachable/i);
  assert.doesNotMatch(JSON.stringify(res.calls.body), /10\.0\.0\.5/);
});

test('translation never overrides portal-authored prose', () => {
  // This message contains ECONNREFUSED, which the translation table matches —
  // but the portal wrote it, so it must survive word for word.
  const err = httpError(400, 'Your test harness reported ECONNREFUSED — check the VM, not the host');
  assert.deepEqual(errorPayload(err), {
    error: 'Your test harness reported ECONNREFUSED — check the VM, not the host',
  });
});

test('the host label the Proxmox client attaches reaches the message', () => {
  const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8006'), {
    upstreamHost: 'pve-cluster-a',
    upstreamHref: '/admin/hosts',
  });
  const body = errorPayload(err);
  assert.match(body.detail, /pve-cluster-a/);
  assert.equal(body.href, '/admin/hosts');
  assert.doesNotMatch(JSON.stringify(body), /10\.0\.0\.5/);
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
