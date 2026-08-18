import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { recoveryCodes, sessions, users, webauthnCredentials } from '../db/schema/index.ts';
import {
  consumeRecoveryCode, hashRecoveryCode, parseStoredSession, removeWebauthnCredential,
  resolveWebauthnConfig, revokeOtherStoredSessions, revokeStoredSession,
} from './accountSecurity.ts';

let testDb: TestDatabase;
const EXPIRE = new Date('2026-08-05T00:00:00.000Z');

before(async () => {
  testDb = await createTestDatabase();
  // recovery_codes / webauthn_credentials carry FKs to users now — seed the owners.
  await testDb.db.insert(users).values([
    { id: 1, username: 'user-one', password: 'x' },
    { id: 4, username: 'user-four', password: 'x' },
    { id: 5, username: 'user-five', password: 'x' },
  ]);
});

after(async () => {
  await testDb.drop();
});

test('WebAuthn config rejects origin/RP mismatches and paths', () => {
  assert.deepEqual(resolveWebauthnConfig({ configuredOrigin: 'https://portal.example.com', rpID: 'example.com' }), {
    origin: 'https://portal.example.com', rpID: 'example.com', rpName: 'Homelabrrr',
  });
  assert.throws(() => resolveWebauthnConfig({ configuredOrigin: 'https://evil.example.net', rpID: 'example.com' }));
  assert.throws(() => resolveWebauthnConfig({ configuredOrigin: 'https://portal.example.com/path' }));
});

test('a recovery code is normalized, consumed once, and rejected on replay', async () => {
  const hash = hashRecoveryCode('ABCD-EF12-3456-7890');
  assert.equal(hash, hashRecoveryCode('abcd ef12 3456 7890'));
  await testDb.db.insert(recoveryCodes).values({ user_id: 1, code_hash: hash });
  assert.equal(await consumeRecoveryCode(testDb.db, 1, hash), true);
  assert.equal(await consumeRecoveryCode(testDb.db, 1, hash), false);
});

test('stored sessions expose safe metadata and ownership for revocation checks', () => {
  const session = parseStoredSession({ sid: 'abc', sess: { userId: 4, clientIp: '203.0.113.2', userAgent: 'Browser' }, expire: EXPIRE }, 'abc');
  assert.ok(session);
  assert.equal(session.current, true);
  assert.equal(session.userId, 4);
  assert.equal(session.expiresAt, EXPIRE);
  assert.equal(parseStoredSession({ sid: 'bad', sess: null, expire: null }, ''), null);
});

test('credential removal is owner-scoped and reports missing credentials', async () => {
  await testDb.db.insert(webauthnCredentials).values({ id: 'credential-1', user_id: 4, name: 'Laptop', public_key: Buffer.from('public-key') });
  assert.equal(await removeWebauthnCredential(testDb.db, 5, 'credential-1'), null);
  assert.equal((await removeWebauthnCredential(testDb.db, 4, 'credential-1'))?.name, 'Laptop');
  assert.equal(await removeWebauthnCredential(testDb.db, 4, 'credential-1'), null);
});

test('session revocation is owner-scoped, preserves current sessions, and supports revoke-all-others', async () => {
  await testDb.db.insert(sessions).values([
    { sid: 'current', sess: { userId: 4 }, expire: EXPIRE },
    { sid: 'mine', sess: { userId: 4 }, expire: EXPIRE },
    { sid: 'other-user', sess: { userId: 5 }, expire: EXPIRE },
  ]);
  assert.equal((await revokeStoredSession(testDb.db, 4, 'current', 'current')).current, true);
  assert.equal((await revokeStoredSession(testDb.db, 5, 'mine', 'current')).missing, true);
  assert.equal((await revokeStoredSession(testDb.db, 4, 'mine', 'current')).ok, true);
  await testDb.db.insert(sessions).values({ sid: 'mine-two', sess: { userId: 4 }, expire: EXPIRE });
  assert.equal(await revokeOtherStoredSessions(testDb.db, 4, 'current'), 1);
  assert.deepEqual(
    await testDb.db.select({ sid: sessions.sid }).from(sessions).orderBy(sessions.sid),
    [{ sid: 'current' }, { sid: 'other-user' }],
  );
});
