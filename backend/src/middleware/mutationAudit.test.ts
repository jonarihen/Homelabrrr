import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';

test('mutation audit records success, denial, and failure without request bodies or secrets', async () => {
  // The db singleton reads DATABASE_URL at import time, so the middleware is
  // exercised in a subprocess pointed at a throwaway database.
  const testDb = await createTestDatabase();
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { EventEmitter } from 'node:events';
      const { db, closeDb } = await import('./src/db/client.ts');
      const { users, auditLog } = await import('./src/db/schema/index.ts');
      const { desc } = await import('drizzle-orm');
      const { auditMutations } = await import('./src/middleware/mutationAudit.ts');
      const [user] = await db.insert(users)
        .values({ username: 'audit-admin', password: 'irrelevant-hash', is_admin: true })
        .returning({ id: users.id, username: users.username });
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
        // The finish handler's INSERT is fire-and-forget (conventions M13) —
        // poll until the row for this request lands.
        let row;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          [row] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
          if (row?.request_id === request.requestId) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(row?.request_id, request.requestId, 'audit row was not written');
        assert.equal(row.outcome, outcome);
        assert.equal(row.target, '/api/sftp/upload');
        assert.doesNotMatch(JSON.stringify(row), /must-not-appear/);
      }
      await closeDb();
    `], {
      cwd: process.cwd(), encoding: 'utf8', env: {
        ...process.env,
        DATABASE_URL: testDb.url,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await testDb.drop();
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
