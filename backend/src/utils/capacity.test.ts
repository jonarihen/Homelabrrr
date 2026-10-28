import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { settings } from '../db/schema/index.ts';

let testDb: TestDatabase;
let tmpDir: string;
let capacity: typeof import('./capacity.ts');

before(async () => {
  testDb = await createTestDatabase();
  // The module under test uses the global db client, which reads DATABASE_URL
  // at import time — set env first, import dynamically after.
  process.env.DATABASE_URL = testDb.url;

  // capacity.ts transitively imports proxmox.ts → the legacy SQLite db.ts,
  // which still initializes (and bootstraps an admin) at import time
  // mid-branch. Point it at a scratch file and satisfy its env requirements.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homelabrrr-cap-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'legacy.sqlite');
  process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';
  process.env.INITIAL_ADMIN_USERNAME ||= 'admin';
  process.env.INITIAL_ADMIN_PASSWORD ||= 'test-admin-password';

  capacity = await import('./capacity.ts');

  // A host whose API is guaranteed unreachable (nothing listens on port 1):
  // assertNodeCapacity must skip, not block, when Proxmox can't be queried.
  // Seeded in the legacy SQLite because proxmox.ts still resolves hosts there.
  const legacy = (await import('../scripts/legacySqliteDb.ts')).default;
  legacy.prepare(
    "INSERT INTO pve_hosts (id, name, host, port, token_id, token_secret) VALUES (1, 'pve', '127.0.0.1', 1, 'tok', 'secret')"
  ).run();
});

after(async () => {
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
  await testDb.drop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('capacity settings default to advisory memory checks when unset', async () => {
  assert.deepEqual(await capacity.getCapacitySettings(), { memoryMode: 'warn', overcommitRatio: 1.5 });
});

test('setCapacitySettings updates each field independently and persists as text', async () => {
  // Mode only — ratio keeps its default.
  assert.deepEqual(await capacity.setCapacitySettings({ memoryMode: 'block' }), { memoryMode: 'block', overcommitRatio: 1.5 });
  // Ratio only (string input) — mode keeps the stored value.
  assert.deepEqual(await capacity.setCapacitySettings({ overcommitRatio: '2.25' }), { memoryMode: 'block', overcommitRatio: 2.25 });
  // No fields ⇒ no writes, current settings returned.
  assert.deepEqual(await capacity.setCapacitySettings({}), { memoryMode: 'block', overcommitRatio: 2.25 });

  // settings.value stays text in PostgreSQL.
  const [row] = await testDb.db.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, 'capacity_memory_overcommit_ratio')).limit(1);
  assert.equal(row?.value, '2.25');
});

test('unrecognized values normalize to safe defaults instead of disabling the rail', async () => {
  assert.deepEqual(await capacity.setCapacitySettings({ memoryMode: 'bogus', overcommitRatio: 'not-a-number' }), {
    memoryMode: 'warn', overcommitRatio: 1.5,
  });
});

test('assertNodeCapacity skips (never blocks) when Proxmox cannot be queried', async () => {
  const { release, ...verdict } = await capacity.assertNodeCapacity('1~pve', { memoryMb: 4096, diskGb: 32, storage: 'local-lvm' });
  assert.deepEqual(verdict, { warnings: [], memoryWarning: '' });
  assert.equal(typeof release, 'function');
});

test('a passed check with reserve holds its request until released (#284)', async () => {
  const { release } = await capacity.assertNodeCapacity('1~pve', { memoryMb: 2048, diskGb: 10, storage: 'local-lvm', reserve: true });
  assert.deepEqual(capacity.pendingReservations('1~pve', 'local-lvm'), { memoryBytes: 2048 * 1024 ** 2, diskBytes: 10 * 1024 ** 3 });
  // Disk is per storage pool, memory per node.
  assert.deepEqual(capacity.pendingReservations('1~pve', 'other-pool'), { memoryBytes: 2048 * 1024 ** 2, diskBytes: 0 });
  assert.deepEqual(capacity.pendingReservations('2~pve', 'local-lvm'), { memoryBytes: 0, diskBytes: 0 });
  release();
  release(); // idempotent
  assert.deepEqual(capacity.pendingReservations('1~pve', 'local-lvm'), { memoryBytes: 0, diskBytes: 0 });
});

test('a forgotten reservation expires instead of blocking the node forever', () => {
  const now = Date.now();
  capacity.reserveCapacity('3~pve', { memoryMb: 1024, diskGb: 5, storage: 'local' }, now);
  assert.equal(capacity.pendingReservations('3~pve', 'local', now).diskBytes, 5 * 1024 ** 3);
  assert.deepEqual(capacity.pendingReservations('3~pve', 'local', now + 2 * 60 * 60 * 1000), { memoryBytes: 0, diskBytes: 0 });
});
