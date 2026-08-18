// Regression coverage for VLAN placement authorization.
// Run with:  node --test src/utils/vlanAccess.test.ts   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVlanTag, checkVlanAssignment } from './vlanAccess.ts';
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

test('admins may use any VLAN, including untagged', async () => {
  for (const vlanTag of [null, '', 0, 1001, 'anything']) {
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
    const refused = await checkVlanAssignment(testDb.db, { userId: user.id, isAdmin: false, vlanTag: 1002 });
    assert.equal(refused?.status, 403);
    assert.match(refused!.error, /do not have access to that VLAN/);
  } finally {
    await testDb.drop();
  }
});
