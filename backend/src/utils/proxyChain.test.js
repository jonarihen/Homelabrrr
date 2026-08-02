// Regression coverage for TRUST_PROXY / X-Forwarded-For chain analysis.
// Run with:  node --test src/utils/proxyChain.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeForwardedFor,
  isPrivateOrLoopback,
  normalizeIp,
  parseForwardedFor,
  parseTrustProxy,
  mismatchWarning,
  DEFAULT_TRUST_PROXY,
} from './proxyChain.js';

// ── TRUST_PROXY parsing (mirrors what src/index.js hands to Express) ──────────

test('TRUST_PROXY parses to hop counts, booleans, or a passthrough string', () => {
  assert.equal(parseTrustProxy(undefined), DEFAULT_TRUST_PROXY);
  assert.equal(parseTrustProxy(null), DEFAULT_TRUST_PROXY);
  assert.equal(parseTrustProxy(''), DEFAULT_TRUST_PROXY);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('0'), 0);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('172.18.0.0/16'), '172.18.0.0/16');
});

// ── Address normalization ────────────────────────────────────────────────────

test('addresses normalize past ports, brackets, zones and IPv4-mapped IPv6', () => {
  assert.equal(normalizeIp('203.0.113.44'), '203.0.113.44');
  assert.equal(normalizeIp('  203.0.113.44  '), '203.0.113.44');
  assert.equal(normalizeIp('203.0.113.44:51234'), '203.0.113.44');
  assert.equal(normalizeIp('::ffff:203.0.113.44'), '203.0.113.44');
  assert.equal(normalizeIp('::FFFF:203.0.113.44'), '203.0.113.44');
  assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(normalizeIp('2001:DB8::1'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp(''), '');
  assert.equal(normalizeIp(undefined), '');
  assert.equal(normalizeIp(null), '');
});

// ── isPrivateOrLoopback ──────────────────────────────────────────────────────

test('private, loopback and link-local IPv4 are detected', () => {
  for (const ip of ['10.0.0.5', '172.16.0.1', '172.18.0.7', '172.31.255.254',
                    '192.168.1.50', '127.0.0.1', '169.254.10.1', '0.0.0.0']) {
    assert.equal(isPrivateOrLoopback(ip), true, ip);
  }
});

test('public IPv4 is not private — including the 172.x space outside /12', () => {
  for (const ip of ['203.0.113.44', '8.8.8.8', '172.15.0.1', '172.32.0.1', '193.168.1.1']) {
    assert.equal(isPrivateOrLoopback(ip), false, ip);
  }
});

test('IPv6 loopback, unique-local and link-local are private; public IPv6 is not', () => {
  assert.equal(isPrivateOrLoopback('::1'), true);
  assert.equal(isPrivateOrLoopback('::'), true);
  assert.equal(isPrivateOrLoopback('fd12:3456::1'), true);
  assert.equal(isPrivateOrLoopback('FC00::1'), true);
  assert.equal(isPrivateOrLoopback('fe80::1%eth0'), true);
  assert.equal(isPrivateOrLoopback('2001:db8::1'), false);
  assert.equal(isPrivateOrLoopback('2a00:1450:4001:82f::200e'), false);
});

test('IPv4-mapped IPv6 is judged on the embedded IPv4 address', () => {
  assert.equal(isPrivateOrLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrLoopback('::ffff:172.18.0.5'), true);
  assert.equal(isPrivateOrLoopback('::ffff:203.0.113.44'), false);
});

test('garbage is never reported as private', () => {
  for (const value of ['', '   ', 'unknown', 'not-an-ip', '999.999.999.999', null, undefined]) {
    assert.equal(isPrivateOrLoopback(value), false, String(value));
  }
});

// ── Header parsing ───────────────────────────────────────────────────────────

test('a malformed X-Forwarded-For is counted by its real entries only', () => {
  assert.deepEqual(parseForwardedFor(undefined), []);
  assert.deepEqual(parseForwardedFor(''), []);
  assert.deepEqual(parseForwardedFor('  ,  , '), []);
  assert.deepEqual(
    parseForwardedFor(' , 203.0.113.44 ,, 172.18.0.1 , '),
    ['203.0.113.44', '172.18.0.1'],
  );
  // Duplicate headers arrive as an array.
  assert.deepEqual(parseForwardedFor(['203.0.113.44', '172.18.0.1']), ['203.0.113.44', '172.18.0.1']);
});

// ── The verdict ──────────────────────────────────────────────────────────────

test('no X-Forwarded-For at all: undecidable, not a mismatch', () => {
  const a = analyzeForwardedFor({ xForwardedFor: undefined, reqIp: '172.18.0.5', trustProxy: '2' });
  assert.equal(a.hops, 0);
  assert.equal(a.agrees, null);
  assert.equal(a.suspicious, false);
  assert.equal(mismatchWarning(a), null);
  assert.match(a.reason, /No X-Forwarded-For/);
});

test('one hop with TRUST_PROXY=1 agrees', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '203.0.113.44',
    reqIp: '203.0.113.44',
    trustProxy: '1',
  });
  assert.equal(a.hops, 1);
  assert.equal(a.trustProxy, 1);
  assert.equal(a.agrees, true);
  assert.equal(a.suspicious, false);
  assert.equal(mismatchWarning(a), null);
});

test('two hops with TRUST_PROXY=2 agrees — the recommended topology', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '203.0.113.44, 172.18.0.1',
    reqIp: '203.0.113.44',
    trustProxy: '2',
  });
  assert.equal(a.hops, 2);
  assert.equal(a.agrees, true);
  assert.equal(a.suspicious, false);
  assert.equal(mismatchWarning(a), null);
  assert.match(a.reason, /matching TRUST_PROXY=2/);
});

test('two hops with TRUST_PROXY=1 is a mismatch and warns once-worthy', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '203.0.113.44, 172.18.0.1',
    reqIp: '172.18.0.1',
    trustProxy: '1',
  });
  assert.equal(a.hops, 2);
  assert.equal(a.agrees, false);
  const warning = mismatchWarning(a);
  assert.ok(warning);
  assert.match(warning, /^\[trust-proxy\]/);
  assert.match(warning, /TRUST_PROXY/);
});

test('X-Forwarded-For present but req.ip is the nginx container — the exact misconfiguration signature', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '203.0.113.44, 10.0.0.9',
    reqIp: '172.18.0.5',
    trustProxy: '1',
  });
  assert.equal(a.suspicious, true);
  assert.equal(a.agrees, false);
  assert.match(a.reason, /172\.18\.0\.5/);
  assert.match(a.reason, /per-IP login lockout/);
  assert.ok(mismatchWarning(a));
});

test('trust proxy disabled entirely leaves req.ip on the proxy — suspicious', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '203.0.113.44, 172.18.0.1',
    reqIp: '172.18.0.5',
    trustProxy: 'false',
  });
  assert.equal(a.trustProxy, false);
  assert.equal(a.agrees, null); // no hop count to compare against
  assert.equal(a.suspicious, true);
  assert.ok(mismatchWarning(a));
});

test('a LAN client on a correctly configured portal is private but NOT suspicious', () => {
  // req.ip is RFC1918 because the user really is on the LAN. With the hop count
  // right, req.ip equals the left-most chain entry — that is what separates a
  // real private client from a proxy address.
  const a = analyzeForwardedFor({
    xForwardedFor: '192.168.1.50, 172.18.0.1',
    reqIp: '192.168.1.50',
    trustProxy: '2',
  });
  assert.equal(a.agrees, true);
  assert.equal(a.suspicious, false);
  assert.equal(mismatchWarning(a), null);
});

test('IPv4-mapped IPv6 req.ip still matches the plain IPv4 chain entry', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '192.168.1.50',
    reqIp: '::ffff:192.168.1.50',
    trustProxy: '1',
  });
  assert.equal(a.suspicious, false);
  assert.equal(a.agrees, true);

  const broken = analyzeForwardedFor({
    xForwardedFor: '2001:db8::1234, fd00::1',
    reqIp: '::ffff:172.18.0.5',
    trustProxy: '1',
  });
  assert.equal(broken.suspicious, true);
});

test('an IPv6 client through two proxies agrees and is not flagged', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '2a00:1450:4001:82f::200e, fd00:dead:beef::1',
    reqIp: '2a00:1450:4001:82f::200e',
    trustProxy: '2',
  });
  assert.equal(a.hops, 2);
  assert.equal(a.agrees, true);
  assert.equal(a.suspicious, false);
});

test('loopback req.ip with a forwarded chain is suspicious', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const a = analyzeForwardedFor({ xForwardedFor: '203.0.113.44, 10.1.1.1', reqIp: ip, trustProxy: '1' });
    assert.equal(a.suspicious, true, ip);
  }
});

test('a malformed / spoofed chain is counted by real entries, and hop count still decides', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: ' , 198.51.100.7 ,, 203.0.113.44 , 172.18.0.1 , ',
    reqIp: '203.0.113.44',
    trustProxy: '2',
  });
  assert.equal(a.hops, 3); // empties and whitespace dropped, 3 real entries
  assert.equal(a.agrees, false);
  // req.ip is public and mid-chain: Express walked 2 trusted hops as configured,
  // so this is a forged prefix rather than a misconfiguration.
  assert.equal(a.suspicious, false);
  assert.ok(mismatchWarning(a));
});

test('TRUST_PROXY unset falls back to the documented default of 1', () => {
  const a = analyzeForwardedFor({ xForwardedFor: '203.0.113.44', reqIp: '203.0.113.44' });
  assert.equal(a.trustProxy, DEFAULT_TRUST_PROXY);
  assert.equal(a.trustProxyConfigured, null);
  assert.equal(a.agrees, true);
  assert.match(a.reason, /TRUST_PROXY=1 \(default\)/);

  const twoHops = analyzeForwardedFor({
    xForwardedFor: '203.0.113.44, 172.18.0.1',
    reqIp: '172.18.0.1',
    trustProxy: '',
  });
  assert.equal(twoHops.agrees, false);
  assert.equal(twoHops.suspicious, true);
  assert.match(twoHops.reason, /TRUST_PROXY=1 \(default\)/);
});

test('a non-numeric TRUST_PROXY cannot be hop-checked but is still explained', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '203.0.113.44, 172.18.0.1',
    reqIp: '203.0.113.44',
    trustProxy: '172.18.0.0/16',
  });
  assert.equal(a.agrees, null);
  assert.equal(a.suspicious, false);
  assert.equal(mismatchWarning(a), null);
  assert.match(a.reason, /not a hop count/);
});

test('TRUST_PROXY=true is called out as client-controlled', () => {
  const a = analyzeForwardedFor({
    xForwardedFor: '198.51.100.7, 203.0.113.44, 172.18.0.1',
    reqIp: '198.51.100.7',
    trustProxy: 'true',
  });
  assert.equal(a.trustProxy, true);
  assert.equal(a.agrees, null);
  assert.match(a.reason, /trusts every hop/);
});

test('analyzeForwardedFor tolerates being called with nothing at all', () => {
  const a = analyzeForwardedFor();
  assert.equal(a.hops, 0);
  assert.equal(a.suspicious, false);
  assert.equal(a.agrees, null);
  assert.equal(mismatchWarning(a), null);
  assert.equal(mismatchWarning(null), null);
});
