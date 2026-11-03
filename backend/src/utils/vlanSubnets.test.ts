import test from 'node:test';
import assert from 'node:assert/strict';
import { userVlanCidrs, vlanRowCidr, vlanRowCidrList, vlanRowsToCidrs } from './vlanSubnets.ts';
import { cidrContains } from './publicIpPools.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, vlans, userVlans, firewalls, firewallVlanSync } from '../db/schema/index.ts';

test('a managed VLAN derives its network from the tag, not from subnet_cidr', () => {
  // Managed VLANs are stored with an empty subnet_cidr on purpose — reading
  // that column alone left every one of them covering nothing.
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'managed', subnet_cidr: '' }), '10.10.10.0/24');
  assert.equal(vlanRowCidr({ tag: 1012, mode: 'managed', subnet_cidr: null }), '10.10.12.0/24');
  assert.equal(vlanRowCidr({ tag: 1126, mode: 'managed' }), '10.11.26.0/24');
});

test('an explicit subnet_cidr wins over the derived network', () => {
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'tagged_only', subnet_cidr: '192.168.5.0/24' }), '192.168.5.0/24');
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'managed', subnet_cidr: ' 172.16.0.0/16 ' }), '172.16.0.0/16');
});

test('a tagged-only VLAN without a CIDR covers nothing', () => {
  // The portal does not address tagged-only VLANs, so there is no range to
  // infer — granting the derived one would hand out access nobody configured.
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'tagged_only', subnet_cidr: '' }), '');
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'tagged_only', subnet_cidr: 'not-a-cidr' }), '');
});

test('a subnet_cidr with no prefix falls back instead of being matched against', () => {
  // ipv4InCidr rejects a prefix-less value, so keeping it would silently deny.
  assert.equal(vlanRowCidr({ tag: 1010, mode: 'managed', subnet_cidr: '10.10.10.0' }), '10.10.10.0/24');
});

test('an unusable tag yields no network rather than a bogus one', () => {
  assert.equal(vlanRowCidr({ tag: 99999, mode: 'managed', subnet_cidr: '' }), '');
  assert.equal(vlanRowCidr(null), '');
});

test('rows collapse to a unique, empty-free CIDR list', () => {
  assert.deepEqual(vlanRowsToCidrs([
    { tag: 1010, mode: 'managed', subnet_cidr: '' },
    { tag: 1010, mode: 'managed', subnet_cidr: '' },
    { tag: 700, mode: 'tagged_only', subnet_cidr: '' },
    { tag: 1012, mode: 'managed', subnet_cidr: '' },
  ]), ['10.10.10.0/24', '10.10.12.0/24']);
  assert.deepEqual(vlanRowsToCidrs(null), []);
});

test('userVlanCidrs reads the assigned rows through the passed db handle', async () => {
  const testDb = await createTestDatabase();
  try {
    const [user] = await testDb.db.insert(users).values({ username: 'vlan-subnet-user', password: 'x' }).returning({ id: users.id });
    const [managed] = await testDb.db.insert(vlans).values({ name: 'm', tag: 1012, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
    // A tagged-only VLAN without a CIDR contributes nothing — assigning it must
    // not widen the returned set.
    const [tagged] = await testDb.db.insert(vlans).values({ name: 't', tag: 700, mode: 'tagged_only', subnet_cidr: '' }).returning({ id: vlans.id });
    await testDb.db.insert(userVlans).values([
      { user_id: user.id, vlan_id: managed.id },
      { user_id: user.id, vlan_id: tagged.id },
    ]);

    assert.deepEqual(await userVlanCidrs(testDb.db, user.id), ['10.10.12.0/24']);
    // A user with no assignments covers nothing.
    const [other] = await testDb.db.insert(users).values({ username: 'vlan-subnet-none', password: 'x' }).returning({ id: users.id });
    assert.deepEqual(await userVlanCidrs(testDb.db, other.id), []);
  } finally {
    await testDb.drop();
  }
});

test('recorded sync subnets win over subnet_cidr and the default; legacy syncs keep the old derivation', (t) => {
  // log() writes through a console bound at import, so watch the stream itself.
  const write = t.mock.method(process.stderr, 'write', () => true);
  const conflicts = () => write.mock.calls.filter((c) => String(c.arguments[0]).includes('vlan_subnet_conflict')).length;
  // (1) recorded beats the default scheme
  assert.deepEqual(vlanRowCidrList({ tag: 1126, mode: 'managed', subnet_cidr: '', synced: ['172.11.26.0/24'] }), ['172.11.26.0/24']);
  assert.equal(conflicts(), 0);
  // (1) recorded beats a conflicting explicit CIDR, with a warning, and never widens
  assert.deepEqual(vlanRowCidrList({ tag: 700, mode: 'tagged_only', subnet_cidr: '10.0.0.0/8', synced: ['192.168.7.0/24'] }), ['192.168.7.0/24']);
  assert.equal(conflicts(), 1);
  // Unrecorded (legacy) syncs fall through to (2) / (3)
  assert.deepEqual(vlanRowCidrList({ tag: 700, mode: 'tagged_only', subnet_cidr: '192.168.5.0/24', synced: [null] }), ['192.168.5.0/24']);
  assert.deepEqual(vlanRowCidrList({ tag: 1010, mode: 'managed', subnet_cidr: '', synced: [null, ''] }), ['10.10.10.0/24']);
  // Mixed: the recorded firewall gets its /24, the legacy one keeps the old derivation
  assert.deepEqual(vlanRowCidrList({ tag: 1126, mode: 'managed', subnet_cidr: '', synced: ['172.11.26.0/24', null] }), ['172.11.26.0/24', '10.11.26.0/24']);
  assert.equal(conflicts(), 1);
});

test('userVlanCidrs applies the precedence per VLAN and grants every recorded firewall subnet', async () => {
  const testDb = await createTestDatabase();
  try {
    const db = testDb.db;
    const fw = async (name) => (await db.insert(firewalls).values({ name, host: '192.0.2.1', api_key: 'k', verify_tls: false }).returning({ id: firewalls.id }))[0].id;
    const fwA = await fw('fw-a');
    const fwB = await fw('fw-b');
    const [user] = await db.insert(users).values({ username: 'vlan-recorded-user', password: 'x' }).returning({ id: users.id });
    const vlan = async (values) => (await db.insert(vlans).values(values).returning({ id: vlans.id }))[0].id;
    const multi = await vlan({ name: 'multi', tag: 1126, mode: 'managed', subnet_cidr: '' });      // two recorded
    const conflict = await vlan({ name: 'conflict', tag: 1127, mode: 'managed', subnet_cidr: '10.0.0.0/8' });
    const explicit = await vlan({ name: 'explicit', tag: 700, mode: 'tagged_only', subnet_cidr: '192.168.5.0/24' });
    const legacy = await vlan({ name: 'legacy', tag: 1012, mode: 'managed', subnet_cidr: '' });    // unrecorded sync
    const mixed = await vlan({ name: 'mixed', tag: 1130, mode: 'managed', subnet_cidr: '' });      // one recorded, one legacy
    await db.insert(userVlans).values([multi, conflict, explicit, legacy, mixed].map((vlan_id) => ({ user_id: user.id, vlan_id })));
    await db.insert(firewallVlanSync).values([
      { firewall_id: fwA, vlan_id: multi, interface_name: 'vlan1126', subnet_cidr: '172.11.26.0/24' },
      { firewall_id: fwB, vlan_id: multi, interface_name: 'vlan1126', subnet_cidr: '192.11.26.0/24' },
      { firewall_id: fwA, vlan_id: conflict, interface_name: 'vlan1127', subnet_cidr: '172.11.27.0/24' },
      { firewall_id: fwA, vlan_id: legacy, interface_name: 'vlan1012', subnet_cidr: null },
      { firewall_id: fwA, vlan_id: mixed, interface_name: 'vlan1130', subnet_cidr: '172.11.30.0/24' },
      { firewall_id: fwB, vlan_id: mixed, interface_name: 'vlan1130', subnet_cidr: null },
    ]);

    const cidrs = await userVlanCidrs(db, user.id);
    assert.deepEqual(cidrs, ['172.11.26.0/24', '192.11.26.0/24', '172.11.27.0/24', '192.168.5.0/24', '10.10.12.0/24', '172.11.30.0/24', '10.11.30.0/24']);
    const allowed = (ip) => cidrs.some((c) => cidrContains(c, ip));
    assert.ok(allowed('192.11.26.20'));     // second firewall's /24
    assert.ok(allowed('172.11.27.20'));
    // Mixed VLAN: recorded /24 on fw-a and the legacy-derived range on fw-b.
    assert.ok(allowed('172.11.30.20'));
    assert.ok(allowed('10.11.30.20'));
    // The default scheme of a recorded VLAN, and the conflicting /8, are denied.
    assert.ok(!allowed('10.11.26.20'));
    assert.ok(!allowed('10.200.0.1'));
    assert.ok(!allowed('192.168.6.1'));
  } finally {
    await testDb.drop();
  }
});
