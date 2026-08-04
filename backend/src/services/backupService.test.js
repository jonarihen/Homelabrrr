import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('backup service verifies both artifacts and records success or destination failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-backup-service-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { access, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const { default: db } = await import('./src/db.js');
      const { createVerifiedBackup } = await import('./src/services/backupService.js');
      const { verifyEncryptedBackup } = await import('./src/utils/encryptedBackup.js');
      const backup = await createVerifiedBackup({ requestId: 'backup-test-request' });
      assert.equal(backup.status, 'verified');
      assert.equal(backup.request_id, 'backup-test-request');
      assert.ok(backup.path.startsWith(process.env.BACKUP_OFFSITE_DIR));
      const filename = backup.path.split('/').at(-1);
      await access(backup.path);
      await access(process.env.BACKUP_DIR + '/' + filename);
      await verifyEncryptedBackup(backup.path, process.env.BACKUP_ENCRYPTION_KEY);
      assert.equal(db.prepare('SELECT path FROM backup_runs WHERE id = ?').get(backup.id).path, backup.path);

      const blockedDestination = join(process.env.BACKUP_TEST_ROOT, 'not-a-directory');
      await writeFile(blockedDestination, 'occupied by a file');
      process.env.BACKUP_OFFSITE_DIR = blockedDestination;
      await assert.rejects(createVerifiedBackup({ requestId: 'backup-failure-request' }));
      const failed = db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(failed.status, 'error');
      assert.equal(failed.request_id, 'backup-failure-request');
      db.close();
    `], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: join(directory, 'database.sqlite'),
        BACKUP_TEST_ROOT: directory,
        BACKUP_DIR: join(directory, 'staging'),
        BACKUP_OFFSITE_DIR: join(directory, 'offsite'),
        BACKUP_ENCRYPTION_KEY: 'backup-service-test-passphrase-that-is-long-enough',
        SECRET_ENCRYPTION_KEY: '44'.repeat(32),
        SESSION_SECRET: 'backup-test-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: 'backup-test-admin',
        INITIAL_ADMIN_PASSWORD: 'backup-test-password-strong',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
