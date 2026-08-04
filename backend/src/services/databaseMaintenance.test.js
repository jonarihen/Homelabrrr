import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retentionModifier } from '../utils/retention.js';

test('retention cutoffs are explicit whole-day SQLite modifiers', () => {
  assert.equal(retentionModifier(90), '-90 days');
  assert.equal(retentionModifier('365'), '-365 days');
  assert.throws(() => retentionModifier(0));
  assert.throws(() => retentionModifier('1 OR 1=1'));
});

test('maintenance deletes bounded terminal history while preserving recent and active rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-retention-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { default: db } = await import('./src/db.js');
      const { runDatabaseMaintenance } = await import('./src/services/databaseMaintenance.js');
      const user = db.prepare('SELECT id FROM users LIMIT 1').get();
      const insert = db.prepare("INSERT INTO provisioned_vms (user_id, node, vmid, name, status, created_at) VALUES (?, '1~pve', ?, ?, ?, datetime('now', ?))");
      insert.run(user.id, 401, 'old-one', 'ready', '-91 days');
      insert.run(user.id, 402, 'old-two', 'error', '-92 days');
      insert.run(user.id, 403, 'recent', 'ready', '-89 days');
      insert.run(user.id, 404, 'active', 'creating', '-200 days');
      const first = runDatabaseMaintenance({ batchSize: 1 });
      assert.equal(first.deleted.provisioned_vms, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provisioned_vms WHERE status IN ('ready', 'error') AND created_at < datetime('now', '-90 days')").get().count, 1);
      runDatabaseMaintenance({ batchSize: 1 });
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provisioned_vms WHERE name = 'recent'").get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM provisioned_vms WHERE name = 'active'").get().count, 1);
      db.close();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
        DB_PATH: join(directory, 'retention.sqlite'),
        SECRET_ENCRYPTION_KEY: '55'.repeat(32),
        SESSION_SECRET: 'retention-test-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: 'retention-admin',
        INITIAL_ADMIN_PASSWORD: 'retention-password-strong',
        JOB_RETENTION_DAYS: '90',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
