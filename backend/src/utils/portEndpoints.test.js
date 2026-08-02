// Regression coverage for endpoint-aware port-forward conflict detection.
// Run with:  node --test src/utils/portEndpoints.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_WAN_ENDPOINT_KEY,
  findPortConflict,
  formatPortRange,
  normalizeEndpointEntry,
  normalizePortProtocol,
  parsePortRange,
  portConflictMessage,
  portRangesOverlap,
  publicEndpointKey,
} from './portEndpoints.js';

const FW = 1;

// A managed_vips row as the route resolves it: NULL public_ip_id keeps meaning
// "the firewall's default WAN address", which the route substitutes in.
const WAN_IP = '198.51.100.1';
const legacy = (port, protocol, label) => ({
  firewallId: FW, publicIpId: null, address: WAN_IP, protocol, port, label,
});
const dedicated = (publicIpId, address, port, protocol, label) => ({
  firewallId: FW, publicIpId, address, protocol, port, label,
});

// ─── Port range parsing ─────────────────────────────────────────────────────

test('a single port parses as a one-wide range', () => {
  assert.deepEqual(parsePortRange(443), { start: 443, end: 443 });
  assert.deepEqual(parsePortRange('443'), { start: 443, end: 443 });
  assert.equal(formatPortRange(parsePortRange('443')), '443');
});

test('a range parses to its bounds and round-trips', () => {
  assert.deepEqual(parsePortRange('4000-5000'), { start: 4000, end: 5000 });
  assert.deepEqual(parsePortRange(' 4000 - 5000 '), { start: 4000, end: 5000 });
  assert.equal(formatPortRange(parsePortRange('4000-5000')), '4000-5000');
});

test('reversed bounds are normalized — a range is a set, not a direction', () => {
  assert.deepEqual(parsePortRange('5000-4000'), { start: 4000, end: 5000 });
});

test('nonsense and out-of-range port specs are rejected', () => {
  for (const bad of ['', null, undefined, 'http', '0', '65536', '1-65536', '80 443', '4000-', '-5000']) {
    assert.equal(parsePortRange(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('only tcp and udp are protocols', () => {
  assert.equal(normalizePortProtocol('TCP'), 'tcp');
  assert.equal(normalizePortProtocol('udp'), 'udp');
  assert.equal(normalizePortProtocol('sctp'), null);
  assert.equal(normalizePortProtocol(''), null);
});

test('overlap is a closed-interval test', () => {
  const r = (start, end) => ({ start, end });
  assert.equal(portRangesOverlap(r(4000, 5000), r(4500, 4500)), true);
  assert.equal(portRangesOverlap(r(4000, 5000), r(5000, 6000)), true); // shares 5000
  assert.equal(portRangesOverlap(r(4000, 4999), r(5000, 6000)), false); // adjacent
  assert.equal(portRangesOverlap(r(443, 443), r(443, 443)), true);
});

// ─── Endpoint keys ──────────────────────────────────────────────────────────

test('the default WAN endpoint and a dedicated address are different namespaces', () => {
  const wan = publicEndpointKey({ firewallId: FW, publicIpId: null, address: '' });
  const dedicatedKey = publicEndpointKey({ firewallId: FW, publicIpId: 7, address: '203.0.113.10' });
  assert.equal(wan, `fw:${FW}|${LEGACY_WAN_ENDPOINT_KEY}`);
  assert.notEqual(wan, dedicatedKey);
});

test('the same address on different firewalls is a different endpoint', () => {
  assert.notEqual(
    publicEndpointKey({ firewallId: 1, address: '203.0.113.10' }),
    publicEndpointKey({ firewallId: 2, address: '203.0.113.10' }),
  );
});

test('an endpoint falls back to its id when no address is known', () => {
  assert.equal(publicEndpointKey({ firewallId: FW, publicIpId: 7 }), `fw:${FW}|pubip:7`);
});

test('entries with an unusable protocol or port normalize to null', () => {
  assert.equal(normalizeEndpointEntry({ firewallId: FW, protocol: 'icmp', port: 443 }), null);
  assert.equal(normalizeEndpointEntry({ firewallId: FW, protocol: 'tcp', port: 'any' }), null);
});

// ─── Conflict detection — the cases the issue calls out ─────────────────────

test('203.0.113.10:4000-5000/tcp conflicts with 203.0.113.10:4500/tcp', () => {
  const existing = [dedicated(7, '203.0.113.10', '4000-5000', 'tcp', 'game-range')];
  const conflict = findPortConflict(existing, dedicated(7, '203.0.113.10', 4500, 'tcp', 'new'));
  assert.ok(conflict);
  assert.equal(conflict.label, 'game-range');
  assert.equal(formatPortRange(conflict.range), '4000-5000');
});

test('443/tcp on two different public IPs is allowed', () => {
  const existing = [dedicated(7, '203.0.113.10', 443, 'tcp', 'user-a-https')];
  assert.equal(findPortConflict(existing, dedicated(8, '203.0.113.11', 443, 'tcp', 'user-b-https')), null);
});

test('443/tcp and 443/udp on the same public IP are allowed', () => {
  const existing = [dedicated(7, '203.0.113.10', 443, 'tcp', 'https')];
  assert.equal(findPortConflict(existing, dedicated(7, '203.0.113.10', 443, 'udp', 'quic')), null);
});

test('the same address, protocol and port conflicts', () => {
  const existing = [dedicated(7, '203.0.113.10', 443, 'tcp', 'https')];
  const conflict = findPortConflict(existing, dedicated(7, '203.0.113.10', 443, 'tcp', 'https-again'));
  assert.ok(conflict);
  assert.equal(conflict.address, '203.0.113.10');
});

test('adjacent ranges on the same address do not conflict', () => {
  const existing = [dedicated(7, '203.0.113.10', '4000-4999', 'tcp', 'low')];
  assert.equal(findPortConflict(existing, dedicated(7, '203.0.113.10', '5000-6000', 'tcp', 'high')), null);
});

test('a range conflicts with itself', () => {
  const existing = [dedicated(7, '203.0.113.10', '4000-5000', 'tcp', 'range')];
  const conflict = findPortConflict(existing, dedicated(7, '203.0.113.10', '4000-5000', 'tcp', 'copy'));
  assert.ok(conflict);
});

test('a range conflicts with a single port inside it, in either direction', () => {
  const asRange = [dedicated(7, '203.0.113.10', '4000-5000', 'tcp', 'range')];
  assert.ok(findPortConflict(asRange, dedicated(7, '203.0.113.10', 4000, 'tcp', 'edge-low')));
  assert.ok(findPortConflict(asRange, dedicated(7, '203.0.113.10', 5000, 'tcp', 'edge-high')));

  const asSingle = [dedicated(7, '203.0.113.10', 4500, 'tcp', 'single')];
  assert.ok(findPortConflict(asSingle, dedicated(7, '203.0.113.10', '4000-5000', 'tcp', 'range')));
});

test('single ports only conflict when they are the same port', () => {
  const existing = [dedicated(7, '203.0.113.10', 25565, 'tcp', 'minecraft')];
  assert.ok(findPortConflict(existing, dedicated(7, '203.0.113.10', 25565, 'tcp', 'other')));
  assert.equal(findPortConflict(existing, dedicated(7, '203.0.113.10', 25566, 'tcp', 'other')), null);
});

// ─── Legacy / default-WAN behavior after the migration ──────────────────────

test('legacy forwards (public_ip_id NULL) still collide with each other', () => {
  const existing = [legacy(443, 'tcp', 'legacy-https')];
  const conflict = findPortConflict(existing, legacy(443, 'tcp', 'new-legacy-https'));
  assert.ok(conflict, 'a legacy forward must still be checked against the default WAN endpoint');
  assert.equal(conflict.label, 'legacy-https');
});

test('a legacy forward and a dedicated-IP forward never collide', () => {
  const existing = [legacy(443, 'tcp', 'legacy-https')];
  assert.equal(findPortConflict(existing, dedicated(7, '203.0.113.10', 443, 'tcp', 'dedicated-https')), null);
  assert.equal(findPortConflict([dedicated(7, '203.0.113.10', 443, 'tcp', 'dedicated')], legacy(443, 'tcp', 'legacy')), null);
});

test('an unresolved legacy endpoint stays its own namespace', () => {
  // Firewall with no external IP configured: both sides fall back to the WAN
  // sentinel, so legacy forwards still guard each other.
  const noAddress = (port, label) => ({ firewallId: FW, publicIpId: null, address: '', protocol: 'tcp', port, label });
  assert.ok(findPortConflict([noAddress(443, 'a')], noAddress(443, 'b')));
  assert.equal(findPortConflict([noAddress(443, 'a')], dedicated(7, '203.0.113.10', 443, 'tcp', 'b')), null);
});

test('two users each get 443 and 25565 on their own addresses', () => {
  const userA = [
    dedicated(7, '203.0.113.10', 443, 'tcp', 'a-https'),
    dedicated(7, '203.0.113.10', 25565, 'tcp', 'a-minecraft'),
  ];
  assert.equal(findPortConflict(userA, dedicated(8, '203.0.113.11', 443, 'tcp', 'b-https')), null);
  assert.equal(findPortConflict(userA, dedicated(8, '203.0.113.11', 25565, 'tcp', 'b-minecraft')), null);
  assert.equal(findPortConflict(userA, dedicated(8, '203.0.113.11', 19132, 'udp', 'b-bedrock')), null);
});

// ─── Error text ─────────────────────────────────────────────────────────────

test('the conflict message names the address, protocol and range', () => {
  const conflict = findPortConflict(
    [dedicated(7, '203.0.113.10', 443, 'tcp', 'https')],
    dedicated(7, '203.0.113.10', 443, 'tcp', 'https-again'),
  );
  const message = portConflictMessage(conflict);
  assert.match(message, /TCP port 443 is already in use on 203\.0\.113\.10/);
  assert.match(message, /another public IP assigned to you/);
});

test('the conflict message reads correctly for a range and for the default WAN', () => {
  const rangeConflict = findPortConflict(
    [dedicated(7, '203.0.113.10', '4000-5000', 'tcp', 'range')],
    dedicated(7, '203.0.113.10', 4500, 'tcp', 'new'),
  );
  assert.match(portConflictMessage(rangeConflict), /TCP ports 4000-5000 are already in use/);

  const wanConflict = findPortConflict(
    [{ firewallId: FW, publicIpId: null, address: '', protocol: 'tcp', port: 443, label: 'legacy' }],
    { firewallId: FW, publicIpId: null, address: '', protocol: 'tcp', port: 443, label: 'new' },
  );
  assert.match(portConflictMessage(wanConflict), /on the default WAN address/);
});
