import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  consumeRecoveryCode, hashRecoveryCode, parseStoredSession, removeWebauthnCredential,
  resolveWebauthnConfig, revokeOtherStoredSessions, revokeStoredSession,
} from './accountSecurity.js';

test('WebAuthn config rejects origin/RP mismatches and paths', () => {
  assert.deepEqual(resolveWebauthnConfig({ configuredOrigin: 'https://portal.example.com', rpID: 'example.com' }), {
    origin: 'https://portal.example.com', rpID: 'example.com', rpName: 'Homelabrrr',
  });
  assert.throws(() => resolveWebauthnConfig({ configuredOrigin: 'https://evil.example.net', rpID: 'example.com' }));
  assert.throws(() => resolveWebauthnConfig({ configuredOrigin: 'https://portal.example.com/path' }));
});

test('a recovery code is normalized, consumed once, and rejected on replay', () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE recovery_codes (id INTEGER PRIMARY KEY, user_id INTEGER, code_hash TEXT, used_at TEXT)');
  const hash = hashRecoveryCode('ABCD-EF12-3456-7890');
  assert.equal(hash, hashRecoveryCode('abcd ef12 3456 7890'));
  database.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (1, ?)').run(hash);
  assert.equal(consumeRecoveryCode(database, 1, hash), true);
  assert.equal(consumeRecoveryCode(database, 1, hash), false);
  database.close();
});

test('stored sessions expose safe metadata and ownership for revocation checks', () => {
  const session = parseStoredSession({ sid: 'abc', sess: JSON.stringify({ userId: 4, clientIp: '203.0.113.2', userAgent: 'Browser' }), expire: '2026-08-05T00:00:00.000Z' }, 'abc');
  assert.equal(session.current, true);
  assert.equal(session.userId, 4);
  assert.equal(session.expiresAt, '2026-08-05T00:00:00.000Z');
  assert.equal(parseStoredSession({ sid: 'bad', sess: '{', expire: '' }, ''), null);
});

test('credential removal is owner-scoped and reports missing credentials', () => {
  const database = new Database(':memory:');
  database.exec("CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id INTEGER, name TEXT); INSERT INTO webauthn_credentials VALUES ('credential-1', 4, 'Laptop')");
  assert.equal(removeWebauthnCredential(database, 5, 'credential-1'), null);
  assert.equal(removeWebauthnCredential(database, 4, 'credential-1').name, 'Laptop');
  assert.equal(removeWebauthnCredential(database, 4, 'credential-1'), null);
  database.close();
});

test('session revocation is owner-scoped, preserves current sessions, and supports revoke-all-others', () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire TEXT)');
  const insert = database.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  insert.run('current', JSON.stringify({ userId: 4 }), '2026-08-05T00:00:00.000Z');
  insert.run('mine', JSON.stringify({ userId: 4 }), '2026-08-05T00:00:00.000Z');
  insert.run('other-user', JSON.stringify({ userId: 5 }), '2026-08-05T00:00:00.000Z');
  assert.equal(revokeStoredSession(database, 4, 'current', 'current').current, true);
  assert.equal(revokeStoredSession(database, 5, 'mine', 'current').missing, true);
  assert.equal(revokeStoredSession(database, 4, 'mine', 'current').ok, true);
  insert.run('mine-two', JSON.stringify({ userId: 4 }), '2026-08-05T00:00:00.000Z');
  assert.equal(revokeOtherStoredSessions(database, 4, 'current'), 1);
  assert.deepEqual(database.prepare('SELECT sid FROM sessions ORDER BY sid').all(), [{ sid: 'current' }, { sid: 'other-user' }]);
  database.close();
});
