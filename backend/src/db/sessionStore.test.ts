import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { sessions, users } from './schema/index.ts';

const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;
const { DrizzleSessionStore } = await import('./sessionStore.ts');
const { trackConsoleSocket, closeSessionConsoles } = await import('../utils/consoleSockets.ts');
const { closeDb } = await import('./client.ts');
const store = new DrizzleSessionStore();

const USER_ID = 21;
const HOUR = 60 * 60 * 1000;

class FakeSocket extends EventEmitter {
  readyState = 1;
  terminated = false;
  close() { this.readyState = 2; }
  terminate() {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
}

async function openConsole(sid: string) {
  const ws = new FakeSocket();
  assert.equal(await trackConsoleSocket(ws, sid, USER_ID, { hasLiveSession: async () => true }), true);
  return ws;
}

function get(sid: string) {
  return new Promise((resolve, reject) => store.get(sid, (err, sess) => err ? reject(err) : resolve(sess)));
}

test.beforeEach(async () => {
  await testDb.db.delete(sessions);
  await testDb.db.delete(users);
  await testDb.db.insert(users).values({ id: USER_ID, username: 'console-user', password: 'unused' });
});

test.after(async () => {
  await closeDb();
  await testDb.drop();
});

test('an expired session found by get() closes its consoles', async () => {
  await testDb.db.insert(sessions).values([
    { sid: 'expired', sess: { userId: USER_ID }, expire: new Date(Date.now() - 1000) },
    { sid: 'current', sess: { userId: USER_ID }, expire: new Date(Date.now() + HOUR) },
  ]);
  const expired = await openConsole('expired');
  const current = await openConsole('current');
  assert.equal(await get('expired'), null);
  assert.equal(expired.terminated, true);
  assert.equal(current.terminated, false);
  assert.deepEqual(await testDb.db.select({ sid: sessions.sid }).from(sessions), [{ sid: 'current' }]);
  closeSessionConsoles('current');
});

test('the expiry prune closes the consoles of every session it deletes', async () => {
  await testDb.db.insert(sessions).values([
    { sid: 'stale-1', sess: { userId: USER_ID }, expire: new Date(Date.now() - HOUR) },
    { sid: 'stale-2', sess: { userId: USER_ID }, expire: new Date(Date.now() - 1000) },
    { sid: 'fresh', sess: { userId: USER_ID }, expire: new Date(Date.now() + HOUR) },
  ]);
  const stale1 = await openConsole('stale-1');
  const stale2 = await openConsole('stale-2');
  const fresh = await openConsole('fresh');
  assert.equal(await store.pruneExpired(), 2);
  assert.equal(stale1.terminated, true);
  assert.equal(stale2.terminated, true);
  assert.equal(fresh.terminated, false);
  closeSessionConsoles('fresh');
});

test('destroy closes the session\'s consoles', async () => {
  await testDb.db.insert(sessions).values({ sid: 'logout', sess: { userId: USER_ID }, expire: new Date(Date.now() + HOUR) });
  const ws = await openConsole('logout');
  await new Promise<void>((resolve, reject) => store.destroy('logout', (err) => err ? reject(err) : resolve()));
  assert.equal(ws.terminated, true);
});

test('hasLiveSession accepts only an unexpired, fully signed-in session of an existing user', async () => {
  await testDb.db.insert(sessions).values([
    { sid: 'live', sess: { userId: USER_ID }, expire: new Date(Date.now() + HOUR) },
    { sid: 'expired', sess: { userId: USER_ID }, expire: new Date(Date.now() - 1000) },
    { sid: 'other-user', sess: { userId: USER_ID + 1 }, expire: new Date(Date.now() + HOUR) },
    { sid: 'enrolling', sess: { userId: USER_ID, twoFactorEnrollmentOnly: true }, expire: new Date(Date.now() + HOUR) },
  ]);
  assert.equal(await store.hasLiveSession('live', USER_ID), true);
  assert.equal(await store.hasLiveSession('missing', USER_ID), false);
  assert.equal(await store.hasLiveSession('expired', USER_ID), false);
  assert.equal(await store.hasLiveSession('other-user', USER_ID), false);
  assert.equal(await store.hasLiveSession('enrolling', USER_ID), false);
  await testDb.db.delete(users).where(eq(users.id, USER_ID));
  assert.equal(await store.hasLiveSession('live', USER_ID), false, 'a deleted user\'s leftover session row is not live');
});

test('a console upgrade that loses the race with revocation is terminated on registration', async () => {
  await testDb.db.insert(sessions).values({ sid: 'revoked', sess: { userId: USER_ID }, expire: new Date(Date.now() + HOUR) });
  const loaded = await get('revoked');
  assert.ok(loaded, 'the upgrade loaded the session before revocation');
  await new Promise<void>((resolve, reject) => store.destroy('revoked', (err) => err ? reject(err) : resolve()));
  const ws = new FakeSocket();
  assert.equal(await trackConsoleSocket(ws, 'revoked', USER_ID, store), false);
  assert.equal(ws.terminated, true);
});
