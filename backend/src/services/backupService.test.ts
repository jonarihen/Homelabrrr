import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desc, eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { backupRuns } from '../db/schema/index.ts';

const execFileAsync = promisify(execFile);

// createVerifiedBackup shells out to pg_dump/pg_restore, which must be present
// AND at least the major version of the server. Skip only when the tools are
// missing or older than the server (the body exercises the full dump → encrypt
// → offsite → verify pipeline).
async function pgDumpSkipReason(): Promise<string | false> {
  try {
    const { stdout: dumpV } = await execFileAsync('pg_dump', ['--version']);
    const dumpMajor = Number(/(\d+)\./.exec(dumpV)?.[1]);
    const server = await createTestDatabase();
    const { rows } = await server.pool.query('SHOW server_version');
    await server.drop();
    const serverMajor = Number(/(\d+)/.exec(String(rows[0].server_version))?.[1]);
    if (!Number.isFinite(dumpMajor) || !Number.isFinite(serverMajor)) return 'could not determine pg_dump/server versions';
    if (dumpMajor < serverMajor) return `pg_dump ${dumpMajor} is older than server ${serverMajor}`;
    return false;
  } catch (err) {
    return `pg_dump unavailable: ${(err as Error).message}`;
  }
}

const SKIP_REASON = await pgDumpSkipReason();

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
