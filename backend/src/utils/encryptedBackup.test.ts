import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decryptBackupFile, encryptBackupFile, verifyEncryptedBackup } from './encryptedBackup.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';

const execFileAsync = promisify(execFile);

// pg_dump/pg_restore must be present AND at least the major version of the
// server — pg_dump aborts on a server newer than itself, so merely checking
// that the binaries exist turns an environment mismatch into a test failure.
// Mirrors the guard in services/backupService.test.ts.
async function pgToolsSkipReason(): Promise<string | false> {
  try {
    const { stdout: dumpV } = await execFileAsync('pg_dump', ['--version']);
    await execFileAsync('pg_restore', ['--version']);
    const dumpMajor = Number(/(\d+)\./.exec(dumpV)?.[1]);
    const server = await createTestDatabase();
    const { rows } = await server.pool.query('SHOW server_version');
    await server.drop();
    const serverMajor = Number(/(\d+)/.exec(String(rows[0].server_version))?.[1]);
    if (!Number.isFinite(dumpMajor) || !Number.isFinite(serverMajor)) return 'could not determine pg_dump/server versions';
    if (dumpMajor < serverMajor) return `pg_dump ${dumpMajor} is older than server ${serverMajor}`;
    return false;
  } catch (err) {
    return `pg_dump/pg_restore unavailable: ${(err as Error).message}`;
  }
}

const PG_TOOLS_SKIP = await pgToolsSkipReason();

const PASS = 'backup-passphrase-that-is-at-least-32-characters';

test('encrypted backup round-trips the exact bytes and detects tampering', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-'));
  try {
    // The envelope is format-agnostic — it protects whatever bytes it is given.
    const source = join(directory, 'source.bin');
    const encrypted = join(directory, 'backup.dump.enc');
    const restored = join(directory, 'restored.bin');
    const payload = randomBytes(64 * 1024);
    await writeFile(source, payload);
    await encryptBackupFile(source, encrypted, PASS);
    assert.notDeepEqual(await readFile(encrypted), payload);
    await decryptBackupFile(encrypted, restored, PASS);
    assert.deepEqual(await readFile(restored), payload);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wrong backup keys fail authentication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-key-'));
  try {
    const source = join(directory, 'plain');
    const encrypted = join(directory, 'backup.enc');
    const restored = join(directory, 'restored');
    await writeFile(source, randomBytes(4096));
    await encryptBackupFile(source, encrypted, 'correct-passphrase-that-is-long-enough');
    await assert.rejects(() => decryptBackupFile(encrypted, restored, 'wrong-passphrase-that-is-also-long'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('verifyEncryptedBackup accepts a real pg_dump archive and rejects a non-dump', { skip: PG_TOOLS_SKIP }, async () => {
  const db = await createTestDatabase();
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-pg-'));
  try {
    const dump = join(directory, 'db.dump');
    await execFileAsync('pg_dump', ['--format=custom', '--no-owner', '--dbname', db.url, '--file', dump]);
    const encrypted = join(directory, 'db.dump.enc');
    await encryptBackupFile(dump, encrypted, PASS);
    // A genuine dump (contains schema_migrations) verifies.
    await verifyEncryptedBackup(encrypted, PASS);

    // Random bytes that decrypt cleanly are still not a readable archive.
    const bogus = join(directory, 'bogus.enc');
    const bogusSource = join(directory, 'bogus.bin');
    await writeFile(bogusSource, randomBytes(8192));
    await encryptBackupFile(bogusSource, bogus, PASS);
    await assert.rejects(() => verifyEncryptedBackup(bogus, PASS), /not a readable pg_dump|missing the schema_migrations/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await db.drop();
  }
});
