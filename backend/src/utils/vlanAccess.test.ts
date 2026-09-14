// Regression coverage for VLAN placement authorization.
// Run with:  node --test src/utils/vlanAccess.test.ts   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVlanTag, checkVlanAssignment, isValidVmNetInterface } from './vlanAccess.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { users, vlans, userVlans } from '../db/schema/index.ts';

// The admin / untagged / invalid paths return before any query — a db that
// throws on use proves they never touch it.
const explodingDb = new Proxy({}, { get() { throw new Error('db should not be queried'); } });

test('parseVlanTag classifies untagged, tagged, and invalid values', () => {
  for (const v of [null, undefined, '', 0, '0']) {
    assert.deepEqual(parseVlanTag(v), { untagged: true }, `${JSON.stringify(v)} is untagged`);
  }
  assert.deepEqual(parseVlanTag(1001), { tag: 1001 });
  assert.deepEqual(parseVlanTag('1001'), { tag: 1001 });
  for (const v of ['abc', '-5', -1, 'ten', {}]) {
    assert.deepEqual(parseVlanTag(v), { invalid: true }, `${JSON.stringify(v)} is invalid`);
  }
});

test('admins may use valid VLANs, including untagged', async () => {
  for (const vlanTag of [null, undefined, '', 0, '0', 1, 4094, 1001, '1001']) {
    assert.equal(
      await checkVlanAssignment(explodingDb as never, { userId: 1, isAdmin: true, vlanTag }),
      null,
    );
  }
});

test('non-admin: untagged/native network is refused with 403', async () => {
  for (const vlanTag of [null, undefined, '', 0, '0']) {
    const res = await checkVlanAssignment(explodingDb as never, { userId: 2, isAdmin: false, vlanTag });
    assert.equal(res?.status, 403);
    assert.match(res!.error, /untagged\/native network is reserved for administrators/);
  }
});

test('malformed VLANs are rejected for every role before querying assignments', async () => {
  for (const vlanTag of [
    '100,trunks=200', '100,bridge=vmbr1', '100x', '100.5', 100.5,
    '1e2', '0x64', ' 100', '100 ', '100\n', '+100', '-1', -1,
    4095, '4095', Infinity, NaN, true, false, [], [100], {}, 'not-a-number',
  ]) {
    assert.deepEqual(parseVlanTag(vlanTag), { invalid: true });
    for (const isAdmin of [false, true]) {
      const res = await checkVlanAssignment(explodingDb as never, { userId: 2, isAdmin, vlanTag });
      assert.equal(res?.status, 400, JSON.stringify(vlanTag));
    }
  }
});

test('valid VLAN boundaries and decimal strings normalize to integers', () => {
  for (const tag of [1, 100, 4094]) {
    assert.deepEqual(parseVlanTag(tag), { tag });
    assert.deepEqual(parseVlanTag(String(tag)), { tag });
  }
  assert.deepEqual(parseVlanTag('00100'), { tag: 100 });
});

test('VM network interfaces are limited to Proxmox net0 through net31', () => {
  for (let index = 0; index <= 31; index++) assert.equal(isValidVmNetInterface(`net${index}`), true);
  for (const value of ['net32', 'net-1', 'net01', 'net0,bridge=vmbr1', 'net0\n', 'ide0', 'description', '__proto__', '', null, 0, ['net0']]) {
    assert.equal(isValidVmNetInterface(value), false, JSON.stringify(value));
  }
});

test('non-admin: assigned VLAN passes, unassigned is refused with 403', async () => {
  const testDb = await createTestDatabase();
  try {
    const [user] = await testDb.db.insert(users).values({ username: 'vlan-access-user', password: 'x' }).returning({ id: users.id });
    const [assigned] = await testDb.db.insert(vlans).values({ name: 'a', tag: 1001, mode: 'managed', subnet_cidr: '' }).returning({ id: vlans.id });
    // A second VLAN exists but is NOT assigned to the user.
    await testDb.db.insert(vlans).values({ name: 'b', tag: 1002, mode: 'managed', subnet_cidr: '' });
    await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: assigned.id });

    for (const vlanTag of [1001, '1001', '01001']) {
      assert.equal(await checkVlanAssignment(testDb.db, { userId: user.id, isAdmin: false, vlanTag }), null);
    }
    const refused = await checkVlanAssignment(testDb.db, { userId: user.id, isAdmin: false, vlanTag: 1002 });
    assert.equal(refused?.status, 403);
    assert.match(refused!.error, /do not have access to that VLAN/);
  } finally {
    await testDb.drop();
  }
});
