import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('mutation audit records success, denial, and failure without request bodies or secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homelabrrr-audit-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { EventEmitter } from 'node:events';
      const { default: db } = await import('./src/db.ts');
      const { auditMutations } = await import('./src/middleware/mutationAudit.ts');
      const user = db.prepare('SELECT id, username FROM users LIMIT 1').get();
      for (const [statusCode, outcome] of [[201, 'success'], [403, 'denied'], [500, 'failed']]) {
        const response = new EventEmitter();
        response.statusCode = statusCode;
        const request = {
          method: 'POST', originalUrl: '/api/sftp/upload?token=must-not-appear',
          requestId: 'audit-request-' + statusCode,
          session: { userId: user.id, username: user.username }, ip: '203.0.113.9',
          body: { password: 'must-not-appear', privateKey: 'must-not-appear' },
        };
        auditMutations(request, response, () => {});
        response.emit('finish');
        const row = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
        assert.equal(row.outcome, outcome);
        assert.equal(row.request_id, request.requestId);
        assert.equal(row.target, '/api/sftp/upload');
        assert.doesNotMatch(JSON.stringify(row), /must-not-appear/);
      }
      db.close();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
        DB_PATH: join(directory, 'audit.sqlite'),
        SECRET_ENCRYPTION_KEY: '66'.repeat(32),
        SESSION_SECRET: 'audit-test-session-secret-is-long-enough',
        INITIAL_ADMIN_USERNAME: 'audit-admin',
        INITIAL_ADMIN_PASSWORD: 'audit-password-strong',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('high-risk route sources declare stable mutation audit actions', async () => {
  // Keep the taxonomy reviewable: these are the concrete mutations called out
  // by issue #114, in addition to the global outcome event above.
  const { readFile } = await import('node:fs/promises');
  const admin = await readFile(new URL('../routes/admin.ts', import.meta.url), 'utf8');
  const ssh = await readFile(new URL('../routes/ssh.ts', import.meta.url), 'utf8');
  const sftp = await readFile(new URL('../routes/sftp.ts', import.meta.url), 'utf8');
  for (const action of ['pve_host_created', 'pve_host_updated', 'pve_host_deleted', 'admin_toggle_permission']) assert.match(admin, new RegExp(action));
  for (const action of ['ssh_key_added', 'ssh_key_deleted', 'ssh_config_updated']) assert.match(ssh, new RegExp(action));
  for (const action of ['sftp_upload', 'sftp_mkdir', 'sftp_delete', 'sftp_rename']) assert.match(sftp, new RegExp(action));
});
