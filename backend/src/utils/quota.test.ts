import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, roles, vmAssignments } from '../db/schema/index.ts';

// quota.ts reads through the singleton db (src/db/client.ts), which needs
// DATABASE_URL at import time — so the module is imported dynamically after
// the throwaway database exists.
let testDb: TestDatabase;
let quota: typeof import('./quota.ts');
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;

  // quota.ts imports proxmox.ts, which still rides the legacy SQLite module
  // (src/db.ts) mid-migration. That module opens DB_PATH, requires the secret
  // key, and bootstraps an admin — all at import time. Point it at a scratch
  // file so the import succeeds; with no pve_hosts rows there, getAllVMs()
  // returns [] without any network access. Drop this block once proxmox.ts
  // is converted to Drizzle.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'homelabrrr-quota-test-'));
  process.env.DB_PATH = path.join(scratch, 'db.sqlite');
  process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';
  process.env.INITIAL_ADMIN_USERNAME ||= 'test-admin';
  process.env.INITIAL_ADMIN_PASSWORD ||= 'test-admin-password-123';

  ({ closeDb } = await import('../db/client.ts'));
  quota = await import('./quota.ts');

  await testDb.db.insert(roles).values({ id: 10, name: 'limited', max_cores: 8, max_memory_gb: 16, max_storage_gb: 100 });
  await testDb.db.insert(users).values([
    { id: 1, username: 'admin-user', password: 'x', is_admin: true },
    { id: 2, username: 'role-limited', password: 'x', role_id: 10 },
    { id: 3, username: 'override-user', password: 'x', role_id: 10, max_cores: 2 },
    { id: 4, username: 'unlimited-user', password: 'x' },
    { id: 5, username: 'assigned-user', password: 'x', max_cores: 4 },
  ]);
  await testDb.db.insert(vmAssignments).values({ user_id: 5, node: '1~pve', vmid: 100 });
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

test('getUserQuota resolves per-user overrides, role defaults, and admins', async () => {
  assert.equal(await quota.getUserQuota(999), null);
  assert.equal((await quota.getUserQuota(1))?.isAdmin, true);
  assert.deepEqual(await quota.getUserQuota(2), {
    isAdmin: false, maxCores: 8, maxMemoryGb: 16, maxStorageGb: 100,
  });
  // Explicit per-user value beats the role's default; other metrics fall back.
  assert.deepEqual(await quota.getUserQuota(3), {
    isAdmin: false, maxCores: 2, maxMemoryGb: 16, maxStorageGb: 100,
  });
  assert.deepEqual(await quota.getUserQuota(4), {
    isAdmin: false, maxCores: null, maxMemoryGb: null, maxStorageGb: null,
  });
});

test('getUserResourceUsage is zero without assignments and skips unreachable clusters', async () => {
  assert.deepEqual(await quota.getUserResourceUsage(4), { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 });
  // User 5 has an assignment, but no PVE hosts are registered, so the
  // cluster resource list is empty and nothing counts.
  assert.deepEqual(await quota.getUserResourceUsage(5), { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 });
});

test('assertUserQuota bypasses admins and unlimited users', async () => {
  await quota.assertUserQuota(1, { addCores: 9999 });
  await quota.assertUserQuota(4, { addCores: 9999, addMemoryMb: 9999 * 1024, addDiskGb: 9999 });
  await quota.assertUserQuota(999); // unknown user: no quota to enforce
});

test('assertUserQuota rejects allocations over a limit with a 403-tagged error', async () => {
  await quota.assertUserQuota(3, { addCores: 2 }); // exactly at the limit passes
  await assert.rejects(quota.assertUserQuota(3, { addCores: 3 }), (err: any) => {
    assert.equal(err.statusCode, 403);
    assert.match(err.message, /CPU quota exceeded: 0\/2 cores/);
    return true;
  });
  await assert.rejects(quota.assertUserQuota(2, { addMemoryMb: 17 * 1024 }), /Memory quota exceeded/);
  await assert.rejects(quota.assertUserQuota(2, { addDiskGb: 101 }), /Storage quota exceeded/);
});

test('sizeToGb parses PVE disk size strings', () => {
  assert.equal(quota.sizeToGb('32G'), 32);
  assert.equal(quota.sizeToGb('512M'), 0.5);
  assert.equal(quota.sizeToGb('1T'), 1024);
  assert.equal(quota.sizeToGb('1.5g'), 1.5);
  assert.equal(quota.sizeToGb('bogus'), null);
  assert.equal(quota.sizeToGb(undefined), null);
});
