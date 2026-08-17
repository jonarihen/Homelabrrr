// Regression coverage for public IPv4 pool address maths.
// Run with:  node --test src/utils/publicIpPools.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_POOL_EXPANSION,
  cidrContains,
  expandCidrAddresses,
  intToIpv4,
  ipv4ToInt,
  normalizeIpv4,
  parseCidr,
  planPoolAddresses,
  usablePoolAddresses,
} from './publicIpPools.ts';

// ─── Address normalization ──────────────────────────────────────────────────

test('dotted quads normalize, everything else is rejected', () => {
  assert.equal(normalizeIpv4('203.0.113.10'), '203.0.113.10');
  assert.equal(normalizeIpv4('  203.0.113.10  '), '203.0.113.10');
  assert.equal(normalizeIpv4('203.0.113.256'), '');
  assert.equal(normalizeIpv4('203.0.113'), '');
  assert.equal(normalizeIpv4('2001:db8::1'), '');
  assert.equal(normalizeIpv4(''), '');
  assert.equal(normalizeIpv4(null), '');
});

test('leading zeros are rejected rather than silently re-interpreted', () => {
  // '010.0.0.1' is octal in some resolvers; aliasing it to 10.0.0.1 would let
  // two spellings of one address slip past UNIQUE(firewall_id, address).
  assert.equal(normalizeIpv4('010.0.0.1'), '');
  assert.equal(normalizeIpv4('203.0.113.010'), '');
});

test('addresses round-trip through their integer form', () => {
  assert.equal(ipv4ToInt('0.0.0.0'), 0);
  assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
  assert.equal(intToIpv4(ipv4ToInt('203.0.113.10')), '203.0.113.10');
  assert.equal(ipv4ToInt('nope'), null);
  assert.equal(intToIpv4(-1), '');
  assert.equal(intToIpv4(4294967296), '');
});

// ─── CIDR parsing ───────────────────────────────────────────────────────────

test('a prefix resolves to its network and broadcast bounds', () => {
  const parsed = parseCidr('203.0.113.8/29');
  assert.equal(parsed.prefix, 29);
  assert.equal(parsed.size, 8);
  assert.equal(parsed.networkAddress, '203.0.113.8');
  assert.equal(parsed.broadcastAddress, '203.0.113.15');
});

test('a host address inside a prefix resolves to that prefix', () => {
  assert.equal(parseCidr('203.0.113.13/29').cidr, '203.0.113.8/29');
});

test('malformed CIDRs are rejected', () => {
  for (const bad of ['203.0.113.0', '203.0.113.0/33', '203.0.113.0/', 'nope/24', '', null]) {
    assert.equal(parseCidr(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('containment is exact at both edges', () => {
  assert.equal(cidrContains('203.0.113.8/29', '203.0.113.8'), true);
  assert.equal(cidrContains('203.0.113.8/29', '203.0.113.15'), true);
  assert.equal(cidrContains('203.0.113.8/29', '203.0.113.7'), false);
  assert.equal(cidrContains('203.0.113.8/29', '203.0.113.16'), false);
  assert.equal(cidrContains('not-a-cidr', '203.0.113.8'), false);
});

// ─── Expansion: the first/last address rule ─────────────────────────────────

test('expansion keeps the first and last address of the prefix', () => {
  // The issue is explicit: a routed transit prefix is not a LAN, so the portal
  // must not assume network/broadcast are unusable. Which addresses the
  // provider keeps is recorded as `reserved`, never guessed.
  const { error, addresses } = expandCidrAddresses('203.0.113.8/29');
  assert.equal(error, null);
  assert.equal(addresses.length, 8);
  assert.equal(addresses[0], '203.0.113.8');
  assert.equal(addresses[addresses.length - 1], '203.0.113.15');
});

test('a /31 yields both of its addresses', () => {
  const { addresses } = expandCidrAddresses('203.0.113.4/31');
  assert.deepEqual(addresses, ['203.0.113.4', '203.0.113.5']);
});

test('a /32 yields exactly the one address', () => {
  assert.deepEqual(expandCidrAddresses('203.0.113.10/32').addresses, ['203.0.113.10']);
});

test('an oversized prefix is refused instead of enumerated', () => {
  const { error, addresses } = expandCidrAddresses('10.0.0.0/8');
  assert.match(error, /more than the/);
  assert.deepEqual(addresses, []);
  // The guard is a parameter, not a hard limit on the maths.
  assert.equal(expandCidrAddresses('203.0.113.0/24', { max: MAX_POOL_EXPANSION }).addresses.length, 256);
});

// ─── Import planning ────────────────────────────────────────────────────────

test('planning a whole prefix produces one available row per address', () => {
  const plan = planPoolAddresses({ cidr: '203.0.113.8/29' });
  assert.equal(plan.error, null);
  assert.equal(plan.add.length, 8);
  assert.ok(plan.add.every((row) => row.state === 'available'));
});

test('reserved addresses are recorded but never counted as usable', () => {
  const plan = planPoolAddresses({
    cidr: '203.0.113.8/29',
    reserved: [{ address: '203.0.113.9', reason: 'provider gateway' }, '203.0.113.8'],
  });
  const gateway = plan.add.find((row) => row.address === '203.0.113.9');
  assert.equal(gateway.state, 'reserved');
  assert.equal(gateway.reserved_reason, 'provider gateway');
  assert.equal(plan.add.find((row) => row.address === '203.0.113.8').state, 'reserved');

  const usable = usablePoolAddresses(plan.add);
  assert.equal(usable.length, 6);
  assert.ok(!usable.includes('203.0.113.9'));
  assert.ok(!usable.includes('203.0.113.8'));
  // …and the last address of the prefix is still on the table.
  assert.ok(usable.includes('203.0.113.15'));
});

test('an explicit address list is taken verbatim', () => {
  const plan = planPoolAddresses({ addresses: ['203.0.113.10', '203.0.113.11'] });
  assert.deepEqual(plan.add.map((row) => row.address), ['203.0.113.10', '203.0.113.11']);
});

test('addresses already stored for the pool are reported as duplicates, not re-added', () => {
  const plan = planPoolAddresses({
    cidr: '203.0.113.8/29',
    existing: [{ address: '203.0.113.8' }, '203.0.113.9'],
  });
  assert.deepEqual(plan.duplicates, ['203.0.113.8', '203.0.113.9']);
  assert.equal(plan.add.length, 6);
});

test('repeats inside one batch collapse', () => {
  const plan = planPoolAddresses({ addresses: ['203.0.113.10', '203.0.113.10'] });
  assert.equal(plan.add.length, 1);
});

test('invalid and out-of-prefix addresses are reported separately', () => {
  const plan = planPoolAddresses({
    cidr: '203.0.113.8/29',
    addresses: ['203.0.113.9', '203.0.113.99', 'banana'],
  });
  assert.deepEqual(plan.invalid, ['banana']);
  assert.deepEqual(plan.outOfRange, ['203.0.113.99']);
  assert.deepEqual(plan.add.map((row) => row.address), ['203.0.113.9']);
});

test('a plan with neither a CIDR nor addresses is an error, not an empty import', () => {
  assert.match(planPoolAddresses({}).error, /CIDR or an explicit list/);
});

test('usablePoolAddresses only counts state=available', () => {
  const rows = [
    { address: '203.0.113.10', state: 'available' },
    { address: '203.0.113.11', state: 'reserved' },
    { address: '203.0.113.12', state: 'assigned' },
    { address: '203.0.113.13', state: 'disabled' },
    { address: '203.0.113.14', state: 'error' },
  ];
  assert.deepEqual(usablePoolAddresses(rows), ['203.0.113.10']);
});
