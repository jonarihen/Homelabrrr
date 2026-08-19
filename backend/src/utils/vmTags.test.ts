import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { settings } from '../db/schema/index.ts';

// vmTags.ts talks to the Drizzle singleton (src/db/client.ts, which reads
// DATABASE_URL at import time) AND transitively imports the legacy SQLite
// singleton through proxmox.ts (still unconverted mid-branch) — so the module
// is imported dynamically after both databases have somewhere to live. The
// scratch SQLite file and the admin-bootstrap env can go once proxmox.ts is
// converted.
let testDb: TestDatabase;
let vmTags: typeof import('./vmTags.ts');
let closeDb: (() => Promise<void>) | undefined;
let sqliteDir: string;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmtags-sqlite-'));
  process.env.DB_PATH = path.join(sqliteDir, 'db.sqlite');
  process.env.INITIAL_ADMIN_USERNAME = 'admin';
  process.env.INITIAL_ADMIN_PASSWORD = 'test-password-for-vmtags-suite';
  process.env.SECRET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
  ({ closeDb } = await import('../db/client.ts'));
  vmTags = await import('./vmTags.ts');
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
  fs.rmSync(sqliteDir, { recursive: true, force: true });
});

async function seedSetting(key: string, value: string) {
  await testDb.db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

test('sanitizePveTag mirrors the PVE tag rules', () => {
  assert.equal(vmTags.sanitizePveTag('Alice Smith'), 'alice-smith');
  // Illegal runs collapse to '-', leading non-[a-z0-9_] and trailing '-' strip.
  assert.equal(vmTags.sanitizePveTag('--Weird__Tag!!'), 'weird__tag');
  assert.equal(vmTags.sanitizePveTag('ok_name-1.2+x'), 'ok_name-1.2+x');
  assert.equal(vmTags.sanitizePveTag(null), '');
  assert.equal(vmTags.sanitizePveTag(undefined), '');
  assert.equal(vmTags.sanitizePveTag('a'.repeat(60)).length, 40);
});

test('getTagSyncSettings returns defaults on an empty settings table', async () => {
  const s = await vmTags.getTagSyncSettings();
  assert.deepEqual(s, {
    paused: false,
    intervalHours: 6,
    pausedBy: null,
    pausedAt: null,
    lastRun: null,
  });
});

test('getTagSyncSettings ignores a non-positive stored interval', async () => {
  await seedSetting('tag_sync_interval_hours', '-3');
  assert.equal((await vmTags.getTagSyncSettings()).intervalHours, 6);
  await seedSetting('tag_sync_interval_hours', 'garbage');
  assert.equal((await vmTags.getTagSyncSettings()).intervalHours, 6);
});

test('getTagSyncSettings survives a corrupt last-run record', async () => {
  await seedSetting('tag_sync_last_run', '{not json');
  assert.equal((await vmTags.getTagSyncSettings()).lastRun, null);
});

test('setTagSyncPaused persists provenance and clears it on resume', async () => {
  await vmTags.setTagSyncPaused(true, 'alice');
  let s = await vmTags.getTagSyncSettings();
  assert.equal(s.paused, true);
  assert.equal(s.pausedBy, 'alice');
  assert.ok(Number.isFinite(Date.parse(s.pausedAt as string)));

  await vmTags.setTagSyncPaused(false);
  s = await vmTags.getTagSyncSettings();
  assert.equal(s.paused, false);
  assert.equal(s.pausedBy, null);
  assert.equal(s.pausedAt, null);
});

test('setTagSyncPaused defaults an unknown actor', async () => {
  await vmTags.setTagSyncPaused(true);
  assert.equal((await vmTags.getTagSyncSettings()).pausedBy, 'unknown');
  await vmTags.setTagSyncPaused(false);
});

test('setTagSyncIntervalHours validates and persists', async () => {
  assert.equal(await vmTags.setTagSyncIntervalHours(12), 12);
  assert.equal((await vmTags.getTagSyncSettings()).intervalHours, 12);
  await assert.rejects(() => vmTags.setTagSyncIntervalHours(0), /positive number of hours/);
  await assert.rejects(() => vmTags.setTagSyncIntervalHours('nope'), /positive number of hours/);
});

test('tag sync lock is idle before any run', () => {
  assert.equal(vmTags.isTagSyncRunning(), false);
  assert.equal(vmTags.getTagSyncProgress(), null);
});

// With no PVE hosts registered the fleet is empty, so the full sync completes
// immediately — this still exercises the lock lifecycle and the persisted
// last-run summary end to end.
test('runFullTagSync persists its summary as the last-run record', async () => {
  const summary = await vmTags.runFullTagSync({ trigger: 'test', pacingMs: 0 });
  assert.equal(summary.checked, 0);
  assert.equal(summary.updated, 0);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.trigger, 'test');
  assert.ok(Number.isFinite(Date.parse(summary.time)));

  assert.equal(vmTags.isTagSyncRunning(), false);
  assert.equal(vmTags.getTagSyncProgress(), null);

  // settings.value stays text — the summary round-trips through JSON.
  const s = await vmTags.getTagSyncSettings();
  assert.deepEqual(s.lastRun, JSON.parse(JSON.stringify(summary)));
});
