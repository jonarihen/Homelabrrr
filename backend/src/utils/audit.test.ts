import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { auditLog } from '../db/schema/index.ts';

// audit.ts writes through the singleton db (src/db/client.ts), which reads
// DATABASE_URL at import time — so the module is imported dynamically after
// the throwaway database exists.
let testDb: TestDatabase;
let audit: typeof import('./audit.ts');
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  ({ closeDb } = await import('../db/client.ts'));
  audit = await import('./audit.ts');
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

async function lastEntry() {
  const rows = await testDb.db.select().from(auditLog).orderBy(auditLog.id);
  return rows[rows.length - 1];
}

test('logAuditEntry applies background-job defaults', async () => {
  await audit.logAuditEntry({ action: 'tag_sync' });
  const row = await lastEntry();
  assert.equal(row.user_id, null);
  assert.equal(row.username, 'system');
  assert.equal(row.action, 'tag_sync');
  assert.equal(row.target, '');
  assert.equal(row.detail, '');
  assert.equal(row.ip, '');
  assert.equal(row.request_id, '');
  assert.equal(row.outcome, 'success');
  assert.ok(row.created_at instanceof Date);
});

test('logAuditEntry stores explicit fields verbatim', async () => {
  await audit.logAuditEntry({
    userId: 7, username: 'alice', action: 'vm_delete', target: 'vm:100',
    detail: 'reason', ip: '203.0.113.9', requestId: 'req-1', outcome: 'failure',
  });
  const row = await lastEntry();
  assert.equal(row.user_id, 7);
  assert.equal(row.username, 'alice');
  assert.equal(row.target, 'vm:100');
  assert.equal(row.detail, 'reason');
  assert.equal(row.ip, '203.0.113.9');
  assert.equal(row.request_id, 'req-1');
  assert.equal(row.outcome, 'failure');
});

test('logAudit attributes the session user and request metadata', async () => {
  const req = {
    session: { userId: 3, username: 'bob' },
    ip: '198.51.100.4',
    requestId: 'req-2',
  };
  await audit.logAudit(req, 'login', 'auth', 'ok', 'success');
  const row = await lastEntry();
  assert.equal(row.user_id, 3);
  assert.equal(row.username, 'bob');
  assert.equal(row.action, 'login');
  assert.equal(row.target, 'auth');
  assert.equal(row.ip, '198.51.100.4');
  assert.equal(row.request_id, 'req-2');
});

test('logAudit marks token-authenticated requests and falls back for anonymous ones', async () => {
  await audit.logAudit({
    session: { userId: 3, username: 'bob' },
    apiToken: { name: 'ci-token' },
    ip: '198.51.100.4',
  }, 'vm_start');
  assert.equal((await lastEntry()).username, 'bob (token: ci-token)');

  // No session: anonymous attribution, ip falls back to the raw socket.
  await audit.logAudit({ socket: { remoteAddress: '192.0.2.8' } }, 'login', '', '', 'failure');
  const row = await lastEntry();
  assert.equal(row.user_id, null);
  assert.equal(row.username, 'anonymous');
  assert.equal(row.ip, '192.0.2.8');
  assert.equal(row.outcome, 'failure');
});
