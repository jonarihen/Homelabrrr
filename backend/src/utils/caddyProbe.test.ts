// Regression coverage for issue #103 defect 2: "LIVE" used to mean "the route
// was pushed", never "the site serves". These assertions pin the part that
// decides which of those a probe observed — and, just as importantly, that the
// failure modes stay distinguishable: a 502 is the user's own upstream, an
// untrusted certificate is ACME still running, a refused connection is the
// Caddy host. Collapsing them into one "site unreachable" is the bug.
// Run with:  node --test src/utils/caddyProbe.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe, probeAddressFor, PROBE_PORT } from './caddyProbe.ts';

test('any sub-500 response proves the request reached the intended site', () => {
  for (const status of [200, 204, 301, 302, 401, 403, 404]) {
    const v = classifyProbe({ status });
    assert.equal(v.ok, true, `HTTP ${status} should count as serving`);
    assert.equal(v.kind, 'serving');
    assert.equal(v.status, status);
  }
});

test('502/503/504 is the user’s own upstream, and says so', () => {
  for (const status of [502, 503, 504]) {
    const v = classifyProbe({ status });
    assert.equal(v.ok, false);
    assert.equal(v.kind, 'upstream');
    assert.match(v.message, /upstream/i);
  }
});

test('another 5xx is reported as its own kind rather than blamed on the upstream', () => {
  const v = classifyProbe({ status: 500 });
  assert.equal(v.kind, 'server-error');
  assert.equal(v.ok, false);
});

test('an untrusted certificate is a distinct state, not a generic failure', () => {
  const v = classifyProbe({ status: 200, tlsError: 'self signed certificate' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'cert');
  assert.match(v.message, /Let’s Encrypt|certificate/i);
  // It must not be mistaken for the upstream being down.
  assert.notEqual(v.kind, 'upstream');
});

test('a certificate problem outranks the status code it was served with', () => {
  // Caddy answers 502 with its internal CA cert while ACME is still running:
  // the certificate is the thing to fix first.
  assert.equal(classifyProbe({ status: 502, tlsError: 'self signed certificate' }).kind, 'cert');
});

test('a connection that never completes is reported against the Caddy host', () => {
  const v = classifyProbe({ networkError: 'connect ECONNREFUSED 10.0.0.5:443' });
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'unreachable');
  assert.equal(v.status, 0);
  assert.match(v.message, new RegExp(String(PROBE_PORT)));
});

test('the port named in an unreachable verdict is the port actually probed', () => {
  assert.match(classifyProbe({ networkError: 'ECONNREFUSED', port: 8443 }).message, /port 8443/);
  assert.match(classifyProbe({ networkError: 'ECONNREFUSED' }).message, new RegExp(`port ${PROBE_PORT}`));
});

test('a network error wins over any status that may also be present', () => {
  assert.equal(classifyProbe({ status: 200, networkError: 'socket hang up' }).kind, 'unreachable');
});

test('no observation at all is unreachable, never silently ok', () => {
  assert.equal(classifyProbe({}).ok, false);
  assert.equal(classifyProbe().ok, false);
  assert.equal(classifyProbe().kind, 'unreachable');
});

test('every verdict carries a message an operator can act on', () => {
  const cases = [{ status: 200 }, { status: 502 }, { status: 500 }, { status: 200, tlsError: 'x' }, { networkError: 'x' }];
  for (const obs of cases) {
    assert.ok(classifyProbe(obs).message.length > 20, `${JSON.stringify(obs)} needs a real message`);
  }
});

// ─── probe target ────────────────────────────────────────────────────────────

test('the probe aims at the Caddy host itself, not at public DNS', () => {
  // Deliberate: the domain resolves to the WAN IP and many homelab routers do
  // not hairpin NAT, so resolving it from inside would fail for unrelated
  // reasons. The admin API URL's host is the Caddy host.
  assert.equal(probeAddressFor({ api_url: 'http://10.0.0.5:2019' }), '10.0.0.5');
  assert.equal(probeAddressFor({ api_url: 'https://caddy.internal:2019/' }), 'caddy.internal');
});

test('an unusable admin URL yields no address, so the caller can skip the probe', () => {
  assert.equal(probeAddressFor({ api_url: 'not a url' }), '');
  assert.equal(probeAddressFor({}), '');
});
