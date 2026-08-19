import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { auditLog, nodeMaintenance, portalNotices } from '../db/schema/index.ts';

// nodeMaintenance.ts writes through the singleton db (src/db/client.ts), which
// reads DATABASE_URL at import time — so the module is imported dynamically
// after the throwaway database exists.
let testDb: TestDatabase;
let maint: typeof import('./nodeMaintenance.ts');
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  ({ closeDb } = await import('../db/client.ts'));
  maint = await import('./nodeMaintenance.ts');
});

after(async () => {
  await closeDb?.();
  await testDb.drop();
});

const REQ = { session: { userId: 1, username: 'admin' }, ip: '10.0.0.1' };

async function auditActions(): Promise<string[]> {
  const rows = await testDb.db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.id);
  return rows.map((r) => r.action);
}

test('enterMaintenance creates the row and an active auto-published notice', async () => {
  const serialized = await maint.enterMaintenance({ node: '1~pve1', reason: 'disk swap', until: null, req: REQ });
  assert.ok(serialized);
  assert.equal(serialized!.node, 'pve1');
  assert.equal(serialized!.nodeRef, '1~pve1');
  assert.equal(serialized!.hostId, 1);
  assert.equal(serialized!.reason, 'disk swap');
  assert.equal(serialized!.until, null);
  assert.equal(serialized!.createdBy, 'admin');

  const rows = await testDb.db.select().from(nodeMaintenance);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].node_name, '1~pve1');
  const [notice] = await testDb.db.select().from(portalNotices).where(eq(portalNotices.id, rows[0].notice_id!));
  assert.equal(notice.active, true);
  assert.equal(notice.source, 'node_maintenance');
  assert.equal(notice.level, 'maintenance');
  assert.match(notice.body!, /pve1 is undergoing maintenance/);
  assert.ok((await auditActions()).includes('node_maintenance_enter'));
});

test('assertNodeAvailable throws 423 for encoded and legacy bare node values', async () => {
  await assert.rejects(maint.assertNodeAvailable('1~pve1'), (err: any) => {
    assert.equal(err.statusCode, 423);
    assert.match(err.message, /pve1 is in maintenance/);
    return true;
  });
  // Legacy bare name matches on node name alone.
  await assert.rejects(maint.assertNodeAvailable('pve1'), (err: any) => err.statusCode === 423);
  // A different host id with the same node name does NOT match.
  await maint.assertNodeAvailable('2~pve1');
  await maint.assertNodeAvailable('1~pve2');
});

test('enterMaintenance for the same node updates in place (no duplicate row/notice)', async () => {
  const until = new Date(Date.now() + 60 * 60 * 1000);
  const serialized = await maint.enterMaintenance({ node: '1~pve1', reason: 'ram swap', until, req: REQ });
  assert.ok(serialized);
  assert.equal(serialized!.reason, 'ram swap');
  assert.ok(serialized!.until instanceof Date);
  assert.ok(serialized!.untilLabel.length > 0);

  const rows = await testDb.db.select().from(nodeMaintenance);
  assert.equal(rows.length, 1);
  const notices = await testDb.db.select().from(portalNotices);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body!, /ram swap/);
  assert.ok((await auditActions()).includes('node_maintenance_update'));
});

test('exitMaintenanceById deletes the row, deactivates the notice, and refuses a second exit', async () => {
  const [row] = await testDb.db.select().from(nodeMaintenance);
  assert.equal(await maint.exitMaintenanceById(row.id, REQ), true);

  assert.equal((await testDb.db.select().from(nodeMaintenance)).length, 0);
  const [notice] = await testDb.db.select().from(portalNotices).where(eq(portalNotices.id, row.notice_id!));
  assert.equal(notice.active, false);
  await maint.assertNodeAvailable('1~pve1'); // no longer blocked

  // Row is gone — a second exit finds nothing to claim.
  assert.equal(await maint.exitMaintenanceById(row.id, REQ), false);
  const actions = await auditActions();
  assert.equal(actions.filter((a) => a === 'node_maintenance_exit').length, 1);
});

test('expired rows are invisible to the active set but swept exactly once', async () => {
  // normalizeUntil refuses past dates, so plant the expired row directly.
  const [notice] = await testDb.db.insert(portalNotices)
    .values({ title: 'Node maintenance — pve9', body: 'x', level: 'maintenance', active: true, source: 'node_maintenance', created_by: 'admin' })
    .returning({ id: portalNotices.id });
  await testDb.db.insert(nodeMaintenance).values({
    pve_host_id: 3, node_name: '3~pve9', reason: 'old', until: new Date(Date.now() - 1000), notice_id: notice.id, created_by: 'admin',
  });

  // SQL-side expiry filter: not active, not blocking.
  assert.equal((await maint.listMaintenance()).length, 0);
  assert.equal(await maint.findMaintenanceForNode('3~pve9'), null);
  await maint.assertNodeAvailable('3~pve9');

  assert.equal(await maint.sweepExpiredMaintenance(), 1);
  assert.equal((await testDb.db.select().from(nodeMaintenance)).length, 0);
  const [closed] = await testDb.db.select().from(portalNotices).where(eq(portalNotices.id, notice.id));
  assert.equal(closed.active, false);
  assert.equal((await auditActions()).filter((a) => a === 'node_maintenance_expire').length, 1);

  // Nothing left to sweep.
  assert.equal(await maint.sweepExpiredMaintenance(), 0);
});

test('claim guard: a racing sweep and admin exit close a row exactly once', async () => {
  const [notice] = await testDb.db.insert(portalNotices)
    .values({ title: 'Node maintenance — pve7', body: 'x', level: 'maintenance', active: true, source: 'node_maintenance', created_by: 'admin' })
    .returning({ id: portalNotices.id });
  const [row] = await testDb.db.insert(nodeMaintenance).values({
    pve_host_id: 4, node_name: '4~pve7', reason: 'race', until: new Date(Date.now() - 1000), notice_id: notice.id, created_by: 'admin',
  }).returning({ id: nodeMaintenance.id });

  const before = (await auditActions()).filter((a) => a.startsWith('node_maintenance_ex')).length;
  const [lifted, exited] = await Promise.all([
    maint.sweepExpiredMaintenance(),
    maint.exitMaintenanceById(row.id, REQ),
  ]);
  // Exactly one side wins the DELETE claim; the loser backs off silently.
  assert.equal(lifted + (exited ? 1 : 0), 1);
  const closes = (await auditActions()).filter((a) => a === 'node_maintenance_exit' || a === 'node_maintenance_expire').length;
  assert.equal(closes - before, 1);
  assert.equal((await testDb.db.select().from(nodeMaintenance)).length, 0);
});

test('enterMaintenance rejects a missing node and normalizes bad until values', async () => {
  await assert.rejects(maint.enterMaintenance({ node: '', req: REQ }), (err: any) => err.statusCode === 400);

  // Unparseable and past "until" values are stored as open-ended (null).
  const serialized = await maint.enterMaintenance({ node: '5~pve5', reason: '', until: 'not-a-date', req: REQ });
  assert.equal(serialized!.until, null);
  const [row] = await testDb.db.select().from(nodeMaintenance).where(eq(nodeMaintenance.node_name, '5~pve5'));
  assert.equal(row.until, null);
  await maint.exitMaintenanceById(row.id, REQ);
});
