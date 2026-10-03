import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPostgresDumpToc, decryptBackupFile, encryptBackupFile, verifyEncryptedBackup } from './encryptedBackup.ts';
import { readBackupSanity } from './backupSanity.ts';
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

test('full restore verification rejects intact-TOC truncated data, mismatched counts and permission failures and cleans up', { skip: PG_TOOLS_SKIP }, async (context) => {
  const db = await createTestDatabase();
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-pg-'));
  try {
    await db.pool.query("INSERT INTO users (username, password) VALUES ('backup-test', 'test-hash')");
    await db.pool.query("INSERT INTO settings (key, value) VALUES ('backup-test', 'value')");
    const dump = join(directory, 'db.dump');
    await execFileAsync('pg_dump', ['--format=custom', '--no-owner', '--dbname', db.url, '--file', dump]);
    const encrypted = join(directory, 'db.dump.enc');
    await encryptBackupFile(dump, encrypted, PASS);
    const expected = await readBackupSanity(db.db);
    const role = `backup_verifier_${randomBytes(8).toString('hex')}`;
    const verifierUrl = new URL(db.url);
    verifierUrl.username = role;
    verifierUrl.password = 'test-password';
    await db.pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'test-password' CREATEDB`);
    const options = { databaseUrl: verifierUrl.toString(), expected };
    try {
      assert.deepEqual(await verifyEncryptedBackup(encrypted, PASS, options), expected);
      await assert.rejects(verifyEncryptedBackup(encrypted, PASS, {
        ...options, expected: { ...expected, users: String(Number(expected.users) + 1) },
      }), /check restored migrations and critical table row counts/);

      const truncated = join(directory, 'truncated.dump');
      const archive = await readFile(dump);
      await writeFile(truncated, archive.subarray(0, archive.length - 100));
      await checkPostgresDumpToc(truncated);
      const truncatedEncrypted = join(directory, 'truncated.dump.enc');
      await encryptBackupFile(truncated, truncatedEncrypted, PASS);
      await assert.rejects(verifyEncryptedBackup(truncatedEncrypted, PASS, options), /could not restore archive data/);

      await db.pool.query(`ALTER ROLE "${role}" NOCREATEDB`);
      await assert.rejects(verifyEncryptedBackup(encrypted, PASS, options), /backup role needs CREATEDB/);
      const databasesAfter = await db.pool.query('SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)', [role]);
      assert.deepEqual(databasesAfter.rows, []);
      assert.deepEqual(await readBackupSanity(db.db), expected);

      const bogus = join(directory, 'bogus.enc');
      const bogusSource = join(directory, 'bogus.bin');
      await writeFile(bogusSource, randomBytes(8192));
      await encryptBackupFile(bogusSource, bogus, PASS);
      await assert.rejects(() => verifyEncryptedBackup(bogus, PASS, options), /not a readable pg_dump|missing the schema_migrations/);

      await db.pool.query(`ALTER ROLE "${role}" CREATEDB`);
      const originalQuery = pg.Client.prototype.query;
      context.mock.method(pg.Client.prototype, 'query', function (...args) {
        if (String(args[0]).startsWith('DROP DATABASE "homelabrrr_verify_')) {
          return Promise.reject(Object.assign(new Error('simulated cleanup failure'), { code: '42501' }));
        }
        return originalQuery.apply(this, args);
      });
      try {
        await assert.rejects(verifyEncryptedBackup(encrypted, PASS, options), /administrator cleanup required/);
      } finally {
        context.mock.restoreAll();
        const leftovers = await db.pool.query('SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)', [role]);
        assert.equal(leftovers.rows.length, 1);
        for (const { datname } of leftovers.rows) {
          assert.match(datname, /^homelabrrr_verify_[a-f0-9]{32}$/);
          await db.pool.query(`DROP DATABASE "${datname}" WITH (FORCE)`);
        }
      }
    } finally {
      await db.pool.query(`DROP ROLE "${role}"`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await db.drop();
  }
});
