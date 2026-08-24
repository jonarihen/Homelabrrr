// Regression coverage for the per-host default storage lookup.
// Run with:  node --test src/utils/cloudImageTargets.test.ts   (from backend/)
//
// cloud_images.default_storage_map became a jsonb column in the PostgreSQL
// migration, so it arrives already parsed. This module kept calling JSON.parse
// on it; JSON.parse stringifies its argument first, so it parsed
// "[object Object]", threw, and the surrounding catch quietly substituted an
// empty map — the configured per-host pool was never applied. The round-trip
// test is the one that pins it, since a hand-built fixture can always be
// written in whichever dialect the code happens to expect.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { cloudImages } from '../db/schema/index.ts';

// cloudImageTargets.ts reaches the singleton db (src/db/client.ts) through
// proxmox.ts, and client.ts throws at import time when DATABASE_URL is unset —
// CI only sets TEST_DATABASE_URL. So the module is imported dynamically once
// the throwaway database exists, the same way middleware/auth.test.ts does it.
let testDb: TestDatabase;
let defaultStorageForHost: typeof import('./cloudImageTargets.ts').defaultStorageForHost;
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  ({ closeDb } = await import('../db/client.ts'));
  ({ defaultStorageForHost } = await import('./cloudImageTargets.ts'));
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

const image = (overrides = {}) => ({
  id: 1,
  name: 'debian-12',
  node: '1~pve',
  storage: 'local',
  default_storage: '',
  default_storage_map: null,
  ...overrides,
});

test('the per-host map resolves a pool for each host', () => {
  const img = image({ default_storage_map: { 1: 'fast-nvme', 2: 'ceph-pool' } });
  assert.equal(defaultStorageForHost(img, 1), 'fast-nvme');
  assert.equal(defaultStorageForHost(img, 2), 'ceph-pool');
});

test('host ids match whether they arrive as numbers or strings', () => {
  const img = image({ default_storage_map: { 3: 'nvme-3' } });
  assert.equal(defaultStorageForHost(img, 3), 'nvme-3');
  assert.equal(defaultStorageForHost(img, '3'), 'nvme-3');
});

test('the per-host map wins over the legacy single default_storage', () => {
  const img = image({ default_storage_map: { 1: 'fast-nvme' }, default_storage: 'local-lvm' });
  assert.equal(defaultStorageForHost(img, 1), 'fast-nvme');
});

test('a host with no entry falls back to default_storage, then to null', () => {
  assert.equal(defaultStorageForHost(image({ default_storage: 'local-lvm' }), 9), 'local-lvm');
  assert.equal(defaultStorageForHost(image({ default_storage_map: { 1: 'fast-nvme' } }), 9), null);
  assert.equal(defaultStorageForHost(image(), 9), null);
});

test('an empty or absent map is not an error', () => {
  assert.equal(defaultStorageForHost(image({ default_storage_map: {} }), 1), null);
  assert.equal(defaultStorageForHost(image({ default_storage_map: null }), 1), null);
});

test('the per-host map survives a round trip through PostgreSQL', async () => {
  await testDb.db.insert(cloudImages).values({
    name: 'debian-12',
    url: 'https://example.invalid/debian-12.qcow2',
    node: '1~pve',
    storage: 'local',
    default_storage_map: { 1: 'fast-nvme', 2: 'ceph-pool' },
  });
  const [stored] = await testDb.db.select().from(cloudImages).limit(1);

  // jsonb comes back parsed — that is precisely why JSON.parse must not run.
  assert.equal(typeof stored.default_storage_map, 'object');

  assert.equal(defaultStorageForHost(stored, 1), 'fast-nvme');
  assert.equal(defaultStorageForHost(stored, 2), 'ceph-pool');
});
