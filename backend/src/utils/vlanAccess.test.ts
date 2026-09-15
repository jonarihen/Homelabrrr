// Regression coverage for VLAN placement authorization.
// Run with:  node --test src/utils/vlanAccess.test.ts   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVlanTag, parseNetInterface, checkVlanAssignment, VLAN_TAG_MIN, VLAN_TAG_MAX } from './vlanAccess.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, vlans, userVlans } from '../db/schema/index.ts';

// The admin / untagged / invalid paths return before any query — a db that
// throws on use proves they never touch it.
const explodingDb = new Proxy({}, { get() { throw new Error('db should not be queried'); } });

test('parseVlanTag classifies untagged, tagged, and invalid values', () => {
  for (const v of [null, undefined, '', ' ', 0, '0', ' 0 ']) {
    assert.deepEqual(parseVlanTag(v), { untagged: true }, `${JSON.stringify(v)} is untagged`);
  }
  assert.deepEqual(parseVlanTag(1001), { tag: 1001 });
  assert.deepEqual(parseVlanTag('1001'), { tag: 1001 });
  assert.deepEqual(parseVlanTag(' 1001 '), { tag: 1001 }, 'surrounding whitespace is trimmed');
  assert.deepEqual(parseVlanTag(VLAN_TAG_MIN), { tag: VLAN_TAG_MIN }, 'the low end of the range is a tag');
  assert.deepEqual(parseVlanTag(VLAN_TAG_MAX), { tag: VLAN_TAG_MAX }, 'the high end of the range is a tag');
  for (const v of ['abc', '-5', -1, 'ten', {}]) {
    assert.deepEqual(parseVlanTag(v), { invalid: true }, `${JSON.stringify(v)} is invalid`);
  }
});

// A NIC config is a comma-delimited property list. Number.parseInt reads
// "100,trunks=200" as 100, so a lax parse would authorize VLAN 100 while the
// caller-supplied string went on to add network properties of its own.
test('parseVlanTag rejects values that smuggle extra NIC properties', () => {
  const crafted = [
    '100,trunks=200',            // appended property
    '100,bridge=vmbr1',
    '100,firewall=0',
    '100 ,trunks=200',
    '100;trunks=200',
    '100\ntrunks=200',
    '100=200',
    '100abc',                    // trailing characters
    '0x64',                      // hex-ish
    '1e3',                       // exponent notation
    '100.5', 100.5,              // fractions
    '+100',                      // sign prefix
  ];
  for (const v of crafted) {
    assert.deepEqual(parseVlanTag(v), { invalid: true }, `${JSON.stringify(v)} must not parse as a tag`);
  }
  // Out of the 802.1Q range.
  for (const v of [VLAN_TAG_MAX + 1, 4096, 99999, '4095', Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    assert.deepEqual(parseVlanTag(v), { invalid: true }, `${JSON.stringify(v)} is out of range`);
  }
  // Non-scalar / coercible types must not sneak through Number() coercion.
  for (const v of [true, false, [100], ['100'], { tag: 100 }, () => 100, 100n]) {
    assert.deepEqual(parseVlanTag(v), { invalid: true }, `${String(v)} is not a tag`);
  }
});

test('parseNetInterface accepts only Proxmox netN keys', () => {
  assert.equal(parseNetInterface(undefined), 'net0', 'defaults to net0');
  assert.equal(parseNetInterface(null), 'net0');
  assert.equal(parseNetInterface(''), 'net0');
  for (const v of ['net0', 'net1', 'net9', 'net10', 'net31', ' net2 ']) {
    assert.equal(parseNetInterface(v), v.trim(), `${JSON.stringify(v)} is a valid NIC key`);
  }
  for (const v of ['net32', 'net00', 'net', 'net-1', 'net0,net1', 'scsi0', 'description',
    '__proto__', 'constructor', 'net0 ,bridge=vmbr1', 0, 1, true, {}, ['net0']]) {
    assert.equal(parseNetInterface(v), null, `${JSON.stringify(v)} must be refused`);
  }
});

test('admins may use any well-formed VLAN, including untagged', async () => {
  for (const vlanTag of [null, '', 0, 1001]) {
    assert.equal(
      await checkVlanAssignment(explodingDb as never, { userId: 1, isAdmin: true, vlanTag }),
      null,
    );
  }
});

// The malformed-tag check runs ahead of the admin bypass so that no caller —
// admin or not — can push a crafted value through to a NIC config.
test('admins are still refused a malformed tag', async () => {
  for (const vlanTag of ['anything', '100,trunks=200', 4095]) {
    const res = await checkVlanAssignment(explodingDb as never, { userId: 1, isAdmin: true, vlanTag });
    assert.equal(res?.status, 400, `${JSON.stringify(vlanTag)} is rejected for admins too`);
  }
});

test('non-admin: untagged/native network is refused with 403', async () => {
  for (const vlanTag of [null, undefined, '', 0, '0']) {
    const res = await checkVlanAssignment(explodingDb as never, { userId: 2, isAdmin: false, vlanTag });
    assert.equal(res?.status, 403);
    assert.match(res!.error, /untagged\/native network is reserved for administrators/);
  }
});

test('non-admin: malformed tag is rejected with 400', async () => {
  const res = await checkVlanAssignment(explodingDb as never, { userId: 2, isAdmin: false, vlanTag: 'not-a-number' });
  assert.equal(res?.status, 400);
});

test('non-admin: assigned VLAN passes, unassigned is refused with 403', async () => {
  const testDb = await createTestDatabase();
  try {
    const [user] = await testDb.db.insert(users).values({ username: 'vlan-access-user', password: 'x' }).returning({ id: users.id });
    const [assigned] = await testDb.db.insert(vlans).values({ name: 'a', tag: 1001, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
    // A second VLAN exists but is NOT assigned to the user.
    await testDb.db.insert(vlans).values({ name: 'b', tag: 1002, mode: 'managed', subnet_cidr: '' });
    await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: assigned.id });

    assert.equal(await checkVlanAssignment(testDb.db, { userId: user.id, isAdmin: false, vlanTag: 1001 }), null);
    assert.equal(await checkVlanAssignment(testDb.db, { userId: user.id, isAdmin: false, vlanTag: '1001' }), null);
    const refused = await checkVlanAssignment(testDb.db, { userId: user.id, isAdmin: false, vlanTag: 1002 });
    assert.equal(refused?.status, 403);
    assert.match(refused!.error, /do not have access to that VLAN/);

    // The crafted value from the report: it must not authorize as VLAN 1001.
    const crafted = await checkVlanAssignment(testDb.db, { userId: user.id, isAdmin: false, vlanTag: '1001,trunks=1002' });
    assert.equal(crafted?.status, 400);
    assert.match(crafted!.error, /Invalid VLAN tag/);
  } finally {
    await testDb.drop();
  }
});
