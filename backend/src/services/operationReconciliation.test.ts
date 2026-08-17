import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { cleanupOperationTracking, operationPhase } from './operationReconciliation.ts';

test('operation phase exposes the first unfinished persisted workflow step', () => {
  assert.equal(operationPhase(JSON.stringify([{ key: 'clone', status: 'done' }, { key: 'configure', status: 'running' }])), 'configure');
  assert.equal(operationPhase('not-json'), '');
});

test('tracking cleanup is terminal-only, idempotent, and changes no resource table', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE provisioned_vms (id INTEGER PRIMARY KEY, status TEXT, upid TEXT);
    CREATE TABLE vm_migrations (id INTEGER PRIMARY KEY, status TEXT, upid TEXT);
    CREATE TABLE resources (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO resources VALUES (1, 'vm-101');
    INSERT INTO provisioned_vms VALUES (7, 'needs_review', 'UPID:test');
    INSERT INTO vm_migrations VALUES (8, 'ok', 'UPID:complete');
  `);
  assert.deepEqual(cleanupOperationTracking(database, 'provision', 7), { ok: false, blocked: true, status: 'needs_review' });
  database.prepare("UPDATE provisioned_vms SET status = 'error' WHERE id = 7").run();
  assert.equal(cleanupOperationTracking(database, 'provision', 7).removed.id, 7);
  assert.deepEqual(cleanupOperationTracking(database, 'provision', 7), { ok: true, alreadyAbsent: true });
  assert.equal(cleanupOperationTracking(database, 'migration', 8).removed.status, 'ok');
  assert.equal(database.prepare('SELECT name FROM resources WHERE id = 1').get().name, 'vm-101');
  database.close();
});
