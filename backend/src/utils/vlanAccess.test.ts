// Regression coverage for VLAN placement authorization.
// Run with:  node --test src/utils/vlanAccess.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVlanTag, checkVlanAssignment } from './vlanAccess.ts';

// Stub db whose assignment lookup returns a row (assigned) or undefined (not).
const dbReturning = (row) => ({ prepare: () => ({ get: () => row }) });
const assignedDb = dbReturning({ id: 7 });
const unassignedDb = dbReturning(undefined);
// Guard: this db must never be queried (used for admin / untagged / invalid paths).
const explodingDb = { prepare: () => { throw new Error('db should not be queried'); } };

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

test('admins may use any VLAN, including untagged', () => {
  for (const vlanTag of [null, '', 0, 1001, 'anything']) {
    assert.equal(
      checkVlanAssignment(explodingDb, { userId: 1, isAdmin: true, vlanTag }),
      null,
    );
  }
});

test('non-admin: untagged/native network is refused with 403', () => {
  for (const vlanTag of [null, undefined, '', 0, '0']) {
    const res = checkVlanAssignment(explodingDb, { userId: 2, isAdmin: false, vlanTag });
    assert.equal(res.status, 403);
    assert.match(res.error, /untagged\/native network is reserved for administrators/);
  }
});

test('non-admin: malformed tag is rejected with 400', () => {
  const res = checkVlanAssignment(explodingDb, { userId: 2, isAdmin: false, vlanTag: 'not-a-number' });
  assert.equal(res.status, 400);
});

test('non-admin: an assigned VLAN is permitted', () => {
  assert.equal(
    checkVlanAssignment(assignedDb, { userId: 2, isAdmin: false, vlanTag: 1001 }),
    null,
  );
});

test('non-admin: an unassigned VLAN is refused with 403', () => {
  const res = checkVlanAssignment(unassignedDb, { userId: 2, isAdmin: false, vlanTag: 1002 });
  assert.equal(res.status, 403);
  assert.match(res.error, /do not have access to that VLAN/);
});
