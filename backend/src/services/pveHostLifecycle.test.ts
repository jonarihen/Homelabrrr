import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('host deletion reports references, blocks them, and deletes a clean unreachable host without probing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-host-delete-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { default: db } = await import('./src/db.ts');
      const { deletePveHost, pveHostDependencies } = await import('./src/services/pveHostLifecycle.ts');
      const user = db.prepare('SELECT id FROM users LIMIT 1').get();
      const anchor = db.prepare("INSERT INTO pve_hosts (name, host, token_id, token_secret) VALUES ('anchor', 'anchor.invalid', 'id', 'secret')").run();
      const host = db.prepare("INSERT INTO pve_hosts (name, host, token_id, token_secret) VALUES ('offline', 'offline.invalid', 'id', 'secret')").run();
      db.prepare('INSERT INTO vm_assignments (user_id, node, vmid) VALUES (?, ?, 100)').run(user.id, host.lastInsertRowid + '~node-a');
      const report = pveHostDependencies(host.lastInsertRowid);
      assert.equal(report.total, 1);
      assert.equal(report.dependencies[0].table, 'vm_assignments');
      assert.throws(() => deletePveHost(host.lastInsertRowid), (error) => error.code === 'PVE_HOST_HAS_DEPENDENCIES');
      db.prepare('DELETE FROM vm_assignments WHERE vmid = 100').run();
      assert.equal(deletePveHost(host.lastInsertRowid).changes, 1);
      assert.throws(() => deletePveHost(anchor.lastInsertRowid), (error) => error.code === 'PVE_LAST_HOST');
      db.close();
    `], {
      cwd: process.cwd(), encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: join(directory, 'host.sqlite'),
        SECRET_ENCRYPTION_KEY: '44'.repeat(32),
        SESSION_SECRET: 'host-lifecycle-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: 'host-admin',
        INITIAL_ADMIN_PASSWORD: 'host-password-strong',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
