// GET /api/admin/audit-log filters, the distinct action list and the CSV export (#282).
// Run with:  node --test src/routes/auditLogFilters.test.ts   (from backend/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, auditLog } from '../db/schema/index.ts';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let app: express.Express;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  const [admin] = await testDb.db.insert(users).values({ username: 'audit-admin', password: 'x', is_admin: true }).returning({ id: users.id });
  await testDb.db.insert(auditLog).values([
    { username: 'alice', action: 'login', target: '', created_at: new Date('2026-10-01T08:00:00Z') },
    { username: 'alice', action: 'vm_action', target: '1~pve/100', created_at: new Date('2026-10-02T23:59:00Z') },
    { username: 'bob', action: 'login_failed', target: '', detail: '=HYPERLINK("x")', created_at: new Date('2026-10-03T00:00:00Z') },
  ]);
  const adminRouter = (await import('./admin.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: admin.id, username: 'audit-admin', isAdmin: true, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/', adminRouter);
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

const actionsOf = (res) => res.body.rows.map((r) => r.action).sort();

test('user and date filters combine; `to` includes its whole day', async () => {
  assert.deepEqual(actionsOf(await request(app).get('/audit-log').query({ user: 'alice' })), ['login', 'vm_action']);
  assert.deepEqual(actionsOf(await request(app).get('/audit-log').query({ from: '2026-10-02', to: '2026-10-02' })), ['vm_action']);
  assert.deepEqual(actionsOf(await request(app).get('/audit-log').query({ from: '2026-10-02' })), ['login_failed', 'vm_action']);
  assert.deepEqual(actionsOf(await request(app).get('/audit-log').query({ user: 'alice', to: '2026-10-01' })), ['login']);
});

test('malformed dates are rejected', async () => {
  for (const bad of ['yesterday', '2026-13-45', '2026-02-30', '2026-04-31', '2025-02-29', '2026-10-1', "2026-10-01' OR 1=1"]) {
    const res = await request(app).get('/audit-log').query({ from: bad });
    assert.equal(res.status, 400, bad);
  }
});

test('the action list comes from the recorded actions', async () => {
  const res = await request(app).get('/audit-log/actions');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ['login', 'login_failed', 'vm_action']);
});

test('CSV export applies the filters, neutralises formulas and is itself audited', async () => {
  const res = await request(app).get('/audit-log.csv').query({ user: 'bob' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  const lines = res.text.trim().split('\r\n');
  assert.equal(lines[0], 'time,user,action,target,detail,ip,outcome,request_id');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^2026-10-03T00:00:00\.000Z,bob,login_failed,,"'=HYPERLINK\(""x""\)",/);
  const [exportRow] = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'admin_export_audit_log'));
  assert.equal(exportRow.detail, '1 row(s)');
});

test('the export is marked truncated only when more rows than the cap match', async () => {
  const insert = (n: number) => testDb.db.execute(sql`
    INSERT INTO audit_log (username, action, target, created_at)
    SELECT 'bulk', 'bulk_action', '', now() FROM generate_series(1, ${n})`);
  const lastExport = async () => (await testDb.db.select().from(auditLog)
    .where(eq(auditLog.action, 'admin_export_audit_log')).orderBy(sql`id DESC`).limit(1))[0].detail;
  await insert(50_000);
  const exact = await request(app).get('/audit-log.csv').query({ user: 'bulk' });
  assert.equal(exact.text.trim().split('\r\n').length, 50_001);
  assert.equal(await lastExport(), '50000 row(s)');
  await insert(1);
  const over = await request(app).get('/audit-log.csv').query({ user: 'bulk' });
  assert.equal(over.text.trim().split('\r\n').length, 50_001);
  assert.equal(await lastExport(), '50000 row(s) (truncated)');
});
