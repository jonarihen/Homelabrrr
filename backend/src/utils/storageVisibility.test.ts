import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { pveHosts } from '../db/schema/index.ts';

let testDb: TestDatabase;
let tmpDir: string;
let sv: typeof import('./storageVisibility.ts');

before(async () => {
  testDb = await createTestDatabase();
  // The module under test uses the global db client, which reads DATABASE_URL
  // at import time — set env first, import dynamically after.
  process.env.DATABASE_URL = testDb.url;

  // storageVisibility.ts transitively imports proxmox.ts → the legacy SQLite
  // db.ts, which still initializes (and bootstraps an admin) at import time
  // mid-branch. Point it at a scratch file and satisfy its env requirements.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homelabrrr-sv-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'legacy.sqlite');
  process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';
  process.env.INITIAL_ADMIN_USERNAME ||= 'admin';
  process.env.INITIAL_ADMIN_PASSWORD ||= 'test-admin-password';

  sv = await import('./storageVisibility.ts');

  // Seed host id 1 in BOTH stores: getHostIdForNode still resolves hosts from
  // the legacy SQLite mid-branch, while storage_visibility rows live in
  // PostgreSQL (FK to pve_hosts). Once proxmox.ts is converted, the PG row
  // keeps this test valid unchanged.
  await testDb.db.insert(pveHosts).values({ id: 1, name: 'pve', host: 'pve.example', token_id: 'tok', token_secret: 'secret' });
  const legacy = (await import('../db.ts')).default;
  legacy.prepare(
    "INSERT INTO pve_hosts (id, name, host, token_id, token_secret) VALUES (1, 'pve', 'pve.example', 'tok', 'secret')"
  ).run();
});

after(async () => {
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
  await testDb.drop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a pool with no row is exposed (default-open), as are calls without host/storage', async () => {
  assert.equal(await sv.storageExposedForHost(1, 'never-configured'), true);
  assert.equal(await sv.storageExposedForHost(null, 'local-lvm'), true);
  assert.equal(await sv.storageExposedForHost(1, ''), true);
});

test('setStorageExposed upserts a single row per (host, storage)', async () => {
  await sv.setStorageExposed(1, 'local-lvm', false);
  assert.equal(await sv.storageExposedForHost(1, 'local-lvm'), false);

  // Same key again flips the existing row instead of inserting a duplicate.
  await sv.setStorageExposed(1, 'local-lvm', true);
  assert.equal(await sv.storageExposedForHost(1, 'local-lvm'), true);

  const map = await sv.storageVisibilityMap(1);
  assert.deepEqual([...map], [['local-lvm', true]]);
});

test('storageVisibilityMap lists only configured pools with boolean flags', async () => {
  await sv.setStorageExposed(1, 'ceph-hidden', false);
  const map = await sv.storageVisibilityMap(1);
  assert.equal(map.get('ceph-hidden'), false);
  assert.equal(map.get('local-lvm'), true);
  assert.equal(map.has('never-configured'), false);
});

test('filterExposedStorages hides unexposed pools for users and bypasses for admins', async () => {
  const storages = [{ storage: 'local-lvm' }, { storage: 'ceph-hidden' }, { storage: 'never-configured' }];

  const forUser = await sv.filterExposedStorages('1~pve', storages, { isAdmin: false });
  assert.deepEqual(forUser.map((s) => s.storage), ['local-lvm', 'never-configured']);

  // Admins (session flag, users-row boolean, or bare true) see everything.
  assert.equal((await sv.filterExposedStorages('1~pve', storages, { isAdmin: true })).length, 3);
  assert.equal((await sv.filterExposedStorages('1~pve', storages, { is_admin: true })).length, 3);
  assert.equal((await sv.filterExposedStorages('1~pve', storages, true)).length, 3);
});

test('assertStorageExposed rejects unexposed pools for non-admins only', async () => {
  await assert.rejects(
    sv.assertStorageExposed('1~pve', 'ceph-hidden', { is_admin: false }),
    (err: any) => err.status === 403,
  );
  await sv.assertStorageExposed('1~pve', 'local-lvm', { is_admin: false });
  await sv.assertStorageExposed('1~pve', 'never-configured', { is_admin: false });
  await sv.assertStorageExposed('1~pve', 'ceph-hidden', { isAdmin: true });
  await sv.assertStorageExposed('1~pve', '', { is_admin: false }); // nothing named ⇒ no-op
});
