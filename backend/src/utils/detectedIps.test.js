// Regression coverage for VM IP auto-detection (issue #68).
// Run with:  node --test src/utils/detectedIps.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIpConfig0,
  normalizeGuestAgentInterfaces,
  rankCandidates,
  isUsableIpv4,
  stripCidr,
  IP_SOURCES,
} from './detectedIps.js';

// ─── stripCidr ───────────────────────────────────────────────────────────────

test('stripCidr splits an address from its prefix', () => {
  assert.deepEqual(stripCidr('10.0.20.50/24'), { ip: '10.0.20.50', prefix: 24 });
  assert.deepEqual(stripCidr('10.0.20.50'), { ip: '10.0.20.50', prefix: null });
  assert.deepEqual(stripCidr('  10.0.20.50/32 '), { ip: '10.0.20.50', prefix: 32 });
  assert.deepEqual(stripCidr('10.0.20.50/nonsense'), { ip: '10.0.20.50', prefix: null });
  assert.deepEqual(stripCidr('10.0.20.50/64'), { ip: '10.0.20.50', prefix: null });
  assert.deepEqual(stripCidr(''), { ip: '', prefix: null });
  assert.deepEqual(stripCidr(null), { ip: '', prefix: null });
  assert.deepEqual(stripCidr(undefined), { ip: '', prefix: null });
});

// ─── isUsableIpv4 ────────────────────────────────────────────────────────────

test('isUsableIpv4 accepts ordinary routable and RFC1918 addresses', () => {
  for (const ip of ['10.0.20.50', '192.168.1.100', '172.16.4.9', '1.2.3.4', '203.0.113.7']) {
    assert.ok(isUsableIpv4(ip), ip);
  }
});

test('isUsableIpv4 rejects loopback, link-local, unspecified and multicast', () => {
  for (const ip of [
    '127.0.0.1',        // loopback — what the guest agent reports for `lo`
    '127.10.20.30',
    '169.254.10.5',     // APIPA: DHCP failed, not an address anyone can reach
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.251',      // mDNS multicast
    '239.255.255.250',
    '255.255.255.255',
  ]) {
    assert.equal(isUsableIpv4(ip), false, ip);
  }
});

test('isUsableIpv4 rejects malformed input and IPv6', () => {
  for (const ip of [
    '', null, undefined, 42, {}, [],
    '10.0.20', '10.0.20.50.1', '10.0.20.256', '10.0.20.-1',
    '10.0.20.50/24',                 // caller must stripCidr first
    'fe80::1', '2001:db8::1', '::1',
    'not-an-ip', '10.0.020.50',
  ]) {
    assert.equal(isUsableIpv4(ip), false, JSON.stringify(ip));
  }
});

// ─── parseIpConfig0 ──────────────────────────────────────────────────────────

test('parseIpConfig0 reads a static cloud-init line with a gateway', () => {
  assert.deepEqual(parseIpConfig0('ip=10.0.20.50/24,gw=10.0.20.1'), {
    ip: '10.0.20.50', prefix: 24, gateway: '10.0.20.1', dhcp: false,
  });
});

test('parseIpConfig0 strips the CIDR suffix and tolerates a missing one', () => {
  assert.equal(parseIpConfig0('ip=10.0.20.50/24')?.ip, '10.0.20.50');
  assert.equal(parseIpConfig0('ip=10.0.20.50/24')?.prefix, 24);
  assert.equal(parseIpConfig0('ip=10.0.20.50')?.ip, '10.0.20.50');
  assert.equal(parseIpConfig0('ip=10.0.20.50')?.prefix, null);
});

test('parseIpConfig0 flags ip=dhcp instead of inventing an address', () => {
  assert.deepEqual(parseIpConfig0('ip=dhcp'), { ip: '', prefix: null, gateway: '', dhcp: true });
  assert.deepEqual(parseIpConfig0('ip=dhcp,ip6=dhcp'), { ip: '', prefix: null, gateway: '', dhcp: true });
  assert.equal(parseIpConfig0('ip=DHCP')?.dhcp, true);
});

test('parseIpConfig0 returns null when nothing is configured', () => {
  for (const value of ['', '   ', null, undefined, 42, {}, ['ip=10.0.20.50']]) {
    assert.equal(parseIpConfig0(value), null, JSON.stringify(value));
  }
  // A line with no ip=/ip6= token at all is "nothing configured" too.
  assert.equal(parseIpConfig0('gw=10.0.20.1'), null);
  assert.equal(parseIpConfig0('garbage'), null);
});

test('parseIpConfig0 drops malformed addresses but still reports the shape', () => {
  assert.deepEqual(parseIpConfig0('ip=999.1.1.1/24,gw=10.0.20.1'), {
    ip: '', prefix: null, gateway: '10.0.20.1', dhcp: false,
  });
  assert.equal(parseIpConfig0('ip=,gw=')?.ip, '');
  assert.equal(parseIpConfig0('ip=127.0.0.1/8')?.ip, '', 'loopback is not a VM address');
  assert.equal(parseIpConfig0('ip=10.0.20.50/24,gw=bogus')?.gateway, '');
});

test('parseIpConfig0 treats an IPv6-only config as having no usable address', () => {
  const parsed = parseIpConfig0('ip6=2001:db8::5/64,gw6=2001:db8::1');
  assert.equal(parsed.ip, '');
  assert.equal(parsed.dhcp, false);
});

test('parseIpConfig0 ignores ordering, spacing and duplicate keys', () => {
  assert.equal(parseIpConfig0(' gw=10.0.20.1 , ip=10.0.20.50/24 ')?.ip, '10.0.20.50');
  assert.equal(parseIpConfig0('ip=10.0.20.50/24,ip=10.0.20.99/24')?.ip, '10.0.20.50');
});

// ─── normalizeGuestAgentInterfaces ───────────────────────────────────────────

const AGENT_PAYLOAD = {
  result: [
    {
      name: 'lo',
      'hardware-address': '00:00:00:00:00:00',
      'ip-addresses': [
        { 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1', prefix: 8 },
        { 'ip-address-type': 'ipv6', 'ip-address': '::1', prefix: 128 },
      ],
    },
    {
      name: 'eth0',
      'hardware-address': 'bc:24:11:aa:bb:cc',
      'ip-addresses': [
        { 'ip-address-type': 'ipv4', 'ip-address': '10.0.20.87', prefix: 24 },
        { 'ip-address-type': 'ipv6', 'ip-address': 'fe80::be24:11ff:feaa:bbcc', prefix: 64 },
      ],
    },
  ],
};

test('normalizeGuestAgentInterfaces flattens the PVE envelope to ip + iface', () => {
  assert.deepEqual(normalizeGuestAgentInterfaces(AGENT_PAYLOAD), [
    { ip: '127.0.0.1', iface: 'lo', prefix: 8 },
    { ip: '10.0.20.87', iface: 'eth0', prefix: 24 },
  ]);
});

test('normalizeGuestAgentInterfaces accepts a bare array as well as the envelope', () => {
  assert.deepEqual(
    normalizeGuestAgentInterfaces(AGENT_PAYLOAD.result),
    normalizeGuestAgentInterfaces(AGENT_PAYLOAD)
  );
});

test('normalizeGuestAgentInterfaces drops IPv6 entries', () => {
  const out = normalizeGuestAgentInterfaces(AGENT_PAYLOAD);
  assert.ok(out.every((entry) => !entry.ip.includes(':')));
});

test('normalizeGuestAgentInterfaces survives missing, partial and junk payloads', () => {
  for (const payload of [null, undefined, {}, [], 'nope', 42, { result: 'nope' }]) {
    assert.deepEqual(normalizeGuestAgentInterfaces(payload), [], JSON.stringify(payload));
  }
  assert.deepEqual(normalizeGuestAgentInterfaces({ result: [{ name: 'eth0' }, null, 5] }), []);
  assert.deepEqual(
    normalizeGuestAgentInterfaces({ result: [{ 'ip-addresses': [{ 'ip-address': '10.0.20.9' }] }] }),
    [{ ip: '10.0.20.9', iface: '', prefix: null }],
    'an untyped address with no interface name is still usable'
  );
});

// ─── rankCandidates ──────────────────────────────────────────────────────────

test('rankCandidates returns an empty list for empty or junk input', () => {
  for (const input of [[], null, undefined, 'nope', 42, [null, 'x', 7, {}]]) {
    assert.deepEqual(rankCandidates(input), [], JSON.stringify(input));
  }
});

test('rankCandidates orders reservation, guest agent, cloud-init, then lease', () => {
  const out = rankCandidates([
    { ip: '10.0.20.87', source: 'dhcp_lease', iface: 'net0' },
    { ip: '10.0.20.60', source: 'cloud_init', iface: 'net0' },
    { ip: '10.0.20.99', source: 'guest_agent', iface: 'eth0' },
    { ip: '10.0.20.50', source: 'dhcp_reservation', iface: 'net0' },
  ]);
  assert.deepEqual(out.map((c) => c.source), ['dhcp_reservation', 'guest_agent', 'cloud_init', 'dhcp_lease']);
  assert.deepEqual(out.map((c) => c.confidence), ['high', 'high', 'medium', 'medium']);
  assert.equal(out[0].ip, '10.0.20.50');
  assert.equal(out[0].iface, 'net0');
});

test('rankCandidates de-duplicates across sources and keeps the best one', () => {
  const out = rankCandidates([
    { ip: '10.0.20.87', source: 'dhcp_lease', iface: 'net0' },
    { ip: '10.0.20.87', source: 'guest_agent', iface: 'eth0' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ip, '10.0.20.87');
  assert.equal(out[0].source, 'guest_agent');
  assert.equal(out[0].iface, 'eth0');
  assert.deepEqual(out[0].sources, ['guest_agent', 'dhcp_lease']);
});

test('rankCandidates promotes a corroborated medium-confidence address to high', () => {
  const single = rankCandidates([{ ip: '10.0.20.87', source: 'dhcp_lease', iface: 'net0' }]);
  assert.equal(single[0].confidence, 'medium');

  const agreed = rankCandidates([
    { ip: '10.0.20.87', source: 'dhcp_lease', iface: 'net0' },
    { ip: '10.0.20.87', source: 'cloud_init', iface: 'net0' },
  ]);
  assert.equal(agreed.length, 1);
  assert.equal(agreed[0].confidence, 'high');
  assert.deepEqual(agreed[0].sources, ['cloud_init', 'dhcp_lease']);
});

test('rankCandidates keeps an interface name even when the best source lacks one', () => {
  const out = rankCandidates([
    { ip: '10.0.20.50', source: 'dhcp_lease', iface: 'net0' },
    { ip: '10.0.20.50', source: 'dhcp_reservation', iface: '' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'dhcp_reservation');
  assert.equal(out[0].iface, 'net0');
});

test('rankCandidates strips CIDR suffixes before comparing', () => {
  const out = rankCandidates([
    { ip: '10.0.20.50/24', source: 'cloud_init', iface: 'net0' },
    { ip: '10.0.20.50', source: 'guest_agent', iface: 'eth0' },
  ]);
  assert.equal(out.length, 1, 'the /24 form must not become a second candidate');
  assert.equal(out[0].ip, '10.0.20.50');
  assert.equal(out[0].source, 'guest_agent');
});

test('rankCandidates rejects loopback, link-local and IPv6 observations', () => {
  const out = rankCandidates([
    { ip: '127.0.0.1', source: 'guest_agent', iface: 'lo' },
    { ip: '169.254.7.9', source: 'guest_agent', iface: 'eth0' },
    { ip: 'fe80::1', source: 'guest_agent', iface: 'eth0' },
    { ip: '::1', source: 'guest_agent', iface: 'lo' },
    { ip: '0.0.0.0', source: 'dhcp_lease', iface: 'net0' },
    { ip: '', source: 'dhcp_lease', iface: 'net0' },
    { ip: '10.0.20.87', source: 'guest_agent', iface: 'eth0' },
  ]);
  assert.deepEqual(out.map((c) => c.ip), ['10.0.20.87']);
});

test('rankCandidates sorts an unknown source last with low confidence', () => {
  const out = rankCandidates([
    { ip: '10.0.20.9', source: 'something_new', iface: '' },
    { ip: '10.0.20.87', source: 'dhcp_lease', iface: 'net0' },
  ]);
  assert.deepEqual(out.map((c) => c.source), ['dhcp_lease', 'something_new']);
  assert.equal(out[1].confidence, 'low');
});

test('rankCandidates is deterministic for two addresses from the same source', () => {
  const raw = [
    { ip: '10.0.20.120', source: 'guest_agent', iface: 'eth1' },
    { ip: '10.0.20.20', source: 'guest_agent', iface: 'eth0' },
  ];
  assert.deepEqual(rankCandidates(raw).map((c) => c.ip), ['10.0.20.20', '10.0.20.120']);
  assert.deepEqual(rankCandidates([...raw].reverse()).map((c) => c.ip), ['10.0.20.20', '10.0.20.120']);
});

test('the end-to-end shape matches the documented API contract', () => {
  const config = parseIpConfig0('ip=10.0.20.50/24,gw=10.0.20.1');
  const agent = normalizeGuestAgentInterfaces(AGENT_PAYLOAD);
  const out = rankCandidates([
    { ip: '10.0.20.50', source: 'dhcp_reservation', iface: 'net0' },
    { ip: '10.0.20.87', source: 'dhcp_lease', iface: 'net0' },
    ...agent.map((entry) => ({ ...entry, source: 'guest_agent' })),
    { ip: config.ip, source: 'cloud_init', iface: 'net0' },
  ]);

  assert.deepEqual(out, [
    { ip: '10.0.20.50', source: 'dhcp_reservation', iface: 'net0', confidence: 'high', sources: ['dhcp_reservation', 'cloud_init'] },
    { ip: '10.0.20.87', source: 'guest_agent', iface: 'eth0', confidence: 'high', sources: ['guest_agent', 'dhcp_lease'] },
  ]);
  assert.ok(Object.keys(IP_SOURCES).every((source) => typeof IP_SOURCES[source].rank === 'number'));
});
