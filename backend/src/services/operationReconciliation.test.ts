import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupOperationTracking, operationPhase } from './operationReconciliation.ts';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { provisionedVms, vmMigrations, users } from '../db/schema/index.ts';
import { eq } from 'drizzle-orm';

test('operation phase exposes the first unfinished persisted workflow step', () => {
  // jsonb column: callers pass a parsed array now (a legacy string still works).
  assert.equal(operationPhase([{ key: 'clone', status: 'done' }, { key: 'configure', status: 'running' }]), 'configure');
  assert.equal(operationPhase(JSON.stringify([{ key: 'clone', status: 'done' }, { key: 'configure', status: 'running' }])), 'configure');
  assert.equal(operationPhase('not-json'), '');
});

test('tracking cleanup is terminal-only, idempotent, and changes no resource table', async () => {
  const testDb = await createTestDatabase();
  try {
    // An unrelated row in a sibling table proves cleanup touches only its own.
    const [owner] = await testDb.db.insert(users).values({ username: 'recon-owner', password: 'x' }).returning({ id: users.id });
    await testDb.db.insert(provisionedVms).values({ id: 7, user_id: owner.id, node: '1~pve', vmid: 101, name: 'vm-101', status: 'needs_review', upid: 'UPID:test' });
    await testDb.db.insert(vmMigrations).values({ id: 8, vmid: 102, source_node: '1~pve', target_node: '2~pve', status: 'ok', upid: 'UPID:complete' });

    assert.deepEqual(await cleanupOperationTracking(testDb.db, 'provision', 7), { ok: false, blocked: true, status: 'needs_review' });
    await testDb.db.update(provisionedVms).set({ status: 'error' }).where(eq(provisionedVms.id, 7));
    const removed = await cleanupOperationTracking(testDb.db, 'provision', 7);
    assert.equal(removed.removed?.id, 7);
    assert.deepEqual(await cleanupOperationTracking(testDb.db, 'provision', 7), { ok: true, alreadyAbsent: true });
    assert.equal((await cleanupOperationTracking(testDb.db, 'migration', 8)).removed?.status, 'ok');
    // The unrelated user row is untouched.
    const [stillThere] = await testDb.db.select({ username: users.username }).from(users).where(eq(users.id, owner.id)).limit(1);
    assert.equal(stillThere.username, 'recon-owner');
  } finally {
    await testDb.drop();
  }
});
