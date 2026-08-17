import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { decryptBackupFile, encryptBackupFile, verifyEncryptedBackup } from './encryptedBackup.ts';

test('encrypted backup round-trips and its isolated restore passes schema/integrity checks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-'));
  try {
    const source = join(directory, 'source.sqlite');
    const encrypted = join(directory, 'backup.sqlite.enc');
    const restored = join(directory, 'restored.sqlite');
    const database = new Database(source);
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (1); CREATE TABLE data (value TEXT); INSERT INTO data VALUES (\'hello\')');
    database.close();
    await encryptBackupFile(source, encrypted, 'backup-passphrase-that-is-at-least-32-characters');
    assert.notDeepEqual(await readFile(encrypted), await readFile(source));
    await verifyEncryptedBackup(encrypted, 'backup-passphrase-that-is-at-least-32-characters');
    await decryptBackupFile(encrypted, restored, 'backup-passphrase-that-is-at-least-32-characters');
    const restoredDatabase = new Database(restored, { readonly: true });
    assert.equal(restoredDatabase.prepare('SELECT value FROM data').get().value, 'hello');
    restoredDatabase.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wrong backup keys fail authentication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-key-'));
  try {
    const source = join(directory, 'plain');
    const encrypted = join(directory, 'backup.enc');
    const restored = join(directory, 'restored');
    const database = new Database(source);
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (1)');
    database.close();
    await encryptBackupFile(source, encrypted, 'correct-passphrase-that-is-long-enough');
    await assert.rejects(() => decryptBackupFile(encrypted, restored, 'wrong-passphrase-that-is-also-long'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
