import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desc, eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { backupRuns } from '../db/schema/index.ts';

// SKIPPED in this environment: createVerifiedBackup shells out to `pg_dump`,
// which must be present AND at least the version of the server it dumps. The
// local dev/CI test server is PostgreSQL 18.x while the available pg_dump is
// 17.x, so a live dump is refused with a version mismatch. Remove the `skip`
// once pg_dump matches the test server (the body below is otherwise complete
// and exercises the full dump → encrypt → offsite → verify pipeline).
const SKIP_REASON = 'requires a pg_dump matching the test PostgreSQL server version';

test('backup service verifies both artifacts and records success or destination failure', { skip: SKIP_REASON }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-service-'));
  const t = await createTestDatabase();
  process.env.DATABASE_URL = t.url;
  process.env.BACKUP_DIR = join(directory, 'staging');
  process.env.BACKUP_OFFSITE_DIR = join(directory, 'offsite');
  process.env.BACKUP_ENCRYPTION_KEY = 'backup-service-test-passphrase-that-is-long-enough';
  const { createVerifiedBackup } = await import('./backupService.ts');
  try {
    const backup = await createVerifiedBackup({ requestId: 'backup-test-request' });
    assert.equal(backup.status, 'verified');
    assert.equal(backup.request_id, 'backup-test-request');
    assert.ok(backup.path.startsWith(process.env.BACKUP_OFFSITE_DIR!));
    assert.ok(backup.path.endsWith('.dump.enc'));
    const filename = backup.path.split('/').at(-1)!;
    await access(backup.path);
    await access(join(process.env.BACKUP_DIR!, filename));
    assert.ok((await stat(backup.path)).size > 0);

    const [persisted] = await t.db.select().from(backupRuns).where(eq(backupRuns.id, backup.id)).limit(1);
    assert.equal(persisted.path, backup.path);

    // A destination that is a plain file (not a directory) fails the mkdir and
    // is recorded as an errored run without throwing the process down.
    const blockedDestination = join(directory, 'not-a-directory');
    await writeFile(blockedDestination, 'occupied by a file');
    process.env.BACKUP_OFFSITE_DIR = blockedDestination;
    await assert.rejects(createVerifiedBackup({ requestId: 'backup-failure-request' }));
    const [failed] = await t.db.select().from(backupRuns).orderBy(desc(backupRuns.id)).limit(1);
    assert.equal(failed.status, 'error');
    assert.equal(failed.request_id, 'backup-failure-request');
  } finally {
    await t.drop();
    rmSync(directory, { recursive: true, force: true });
  }
});
