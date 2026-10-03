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
import { randomBytes } from 'node:crypto';
import { backupRuns } from '../db/schema/index.ts';
import { runMigrations } from '../db/migrate.ts';

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
  const { createVerifiedBackup, backupStatus } = await import('./backupService.ts');
  try {
    await t.pool.query('ALTER TABLE backup_runs DROP COLUMN full_restore_verified_at');
    await t.pool.query('DELETE FROM schema_migrations WHERE version = 3');
    await t.pool.query("INSERT INTO backup_runs (status, verified_at) VALUES ('verified', now())");
    assert.equal(await runMigrations(t.pool), 1);
    const beforeFullRestore = await backupStatus();
    assert.equal(beforeFullRestore.latest.status, 'toc_checked');
    assert.ok(beforeFullRestore.latest.verified_at instanceof Date);
    assert.equal(beforeFullRestore.latest.full_restore_verified_at, null);
    assert.equal(beforeFullRestore.lastFullRestoreVerifiedAt, null);
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
    assert.ok(persisted.full_restore_verified_at instanceof Date);
    assert.deepEqual(persisted.full_restore_verified_at, persisted.verified_at);
    assert.deepEqual((await backupStatus()).lastFullRestoreVerifiedAt, persisted.full_restore_verified_at);

    const role = `backup_service_no_createdb_${randomBytes(8).toString('hex')}`;
    const restrictedUrl = new URL(t.url);
    restrictedUrl.username = role;
    restrictedUrl.password = 'test-password';
    await t.pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'test-password' NOCREATEDB`);
    await t.pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await t.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
    await t.pool.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    try {
      process.env.DATABASE_URL = restrictedUrl.toString();
      await assert.rejects(createVerifiedBackup({ requestId: 'backup-restore-failure' }), /backup role needs CREATEDB/);
      const [restoreFailed] = await t.db.select().from(backupRuns).orderBy(desc(backupRuns.id)).limit(1);
      assert.equal(restoreFailed.status, 'error');
      assert.equal(restoreFailed.full_restore_verified_at, null);
      assert.equal(restoreFailed.verified_at, null);
      await assert.rejects(access(restoreFailed.path));
      await assert.rejects(access(join(process.env.BACKUP_DIR!, restoreFailed.path.split('/').at(-1)!)));
      assert.deepEqual((await backupStatus()).lastFullRestoreVerifiedAt, persisted.full_restore_verified_at);
    } finally {
      process.env.DATABASE_URL = t.url;
      await t.pool.query(`DROP OWNED BY "${role}"`);
      await t.pool.query(`DROP ROLE "${role}"`);
    }

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
