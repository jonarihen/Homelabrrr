import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import {
  auditLog, users, vmMigrations, vmAssignments, vmSshConfigs, vmSshUserConfigs, vmTemplates, provisionedVms,
  vmLeases, vmSchedules, pveHosts,
} from '../db/schema/index.ts';
import type { finalizeMigrationSuccess as FinalizeMigrationSuccess } from './migrate.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let finalizeMigrationSuccess: typeof FinalizeMigrationSuccess;
let ownerId: number;
let client: typeof import('../db/client.ts');
let finalizeMigration: typeof import('./migrate.ts').finalizeMigration;

const sourceNode = '1~source';
const targetNode = '2~target';
const steps = [
  { key: 'prepare', status: 'done', note: 'prepared' },
  { key: 'transfer', status: 'active', note: 'copying' },
  { key: 'finalize', status: 'pending', note: '' },
  { key: 'optional', status: 'skipped', note: 'not needed' },
  { key: 'relocate', status: 'error', note: 'manual move needed' },
];

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '99'.repeat(32);
  client = await import('../db/client.ts');
  ({ closeDb } = client);
  ({ finalizeMigrationSuccess, finalizeMigration } = await import('./migrate.ts'));
  const { encryptSecret } = await import('../utils/secrets.ts');
  await testDb.db.insert(pveHosts).values({
    id: 1, name: 'source', host: 'source.example.test', port: 8006,
    token_id: 'root@pam!test', token_secret: encryptSecret('test-secret'), verify_tls: true,
  });
  const [owner] = await testDb.db.insert(users)
    .values({ username: 'migration-admin', password: 'x', is_admin: true })
    .returning({ id: users.id });
  ownerId = owner.id;

  const router = (await import('./operations.ts')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: ownerId, username: 'migration-admin', isAdmin: true, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/operations', router);
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

async function seedMigration(vmid: number, status = 'needs_review', mode = 'remote_migrate') {
  const [migration] = await testDb.db.insert(vmMigrations).values({
    user_id: ownerId, vmid, source_node: sourceNode, target_node: targetNode,
    status, status_detail: 'Interrupted for review', mode, steps, kept_source: true,
    upstream_status: 'stopped:OK', upstream_checked_at: new Date(),
  }).returning();
  return migration;
}

async function seedLinkedRows(vmid: number) {
  const [assignment] = await testDb.db.insert(vmAssignments)
    .values({ user_id: ownerId, node: sourceNode, vmid }).returning();
  const [ssh] = await testDb.db.insert(vmSshConfigs)
    .values({ node: 'source', vmid, host: '192.0.2.10', port: 2222, username: 'guest', host_fingerprint: 'fingerprint' }).returning();
  const [userSsh] = await testDb.db.insert(vmSshUserConfigs)
    .values({ user_id: ownerId, node: sourceNode, vmid, username: 'user-guest' }).returning();
  const [template] = await testDb.db.insert(vmTemplates)
    .values({ node: 'source', vmid, name: 'migrated-template', default_cores: 4 }).returning();
  const [provisioning] = await testDb.db.insert(provisionedVms)
    .values({ user_id: ownerId, node: sourceNode, vmid, name: 'provisioned-guest', template_id: template.id, status: 'ready' }).returning();
  const [lease] = await testDb.db.insert(vmLeases).values({
    node: 'source', vmid, lease_days: 14, renewal_count: 2, exempt: true,
  }).returning();
  const [schedule] = await testDb.db.insert(vmSchedules).values({
    node: sourceNode, vmid, stop_time: '23:00', start_time: '07:00',
    skip_until: 1791000000000, running_due_to_manual: true,
  }).returning();
  return [
    { table: vmAssignments, row: assignment },
    { table: vmSshConfigs, row: ssh },
    { table: vmSshUserConfigs, row: userSsh },
    { table: vmTemplates, row: template },
    { table: provisionedVms, row: provisioning },
    { table: vmLeases, row: lease },
    { table: vmSchedules, row: schedule },
  ];
}

async function readMigration(id: number) {
  const [row] = await testDb.db.select().from(vmMigrations).where(eq(vmMigrations.id, id));
  return row;
}

const resolve = (id: number, status: string) => request(app).post(`/operations/migration/${id}/resolve`).send({ status });

test('manual needs_review to ok repoints all existing VM-linked rows, including legacy nodes', async () => {
  const migration = await seedMigration(301);
  const linked = await seedLinkedRows(301);
  const unrelated = await testDb.db.insert(vmSshConfigs).values([
    { node: '3~source', vmid: 301, host: '192.0.2.11' },
    { node: sourceNode, vmid: 302, host: '192.0.2.12' },
  ]).returning();

  const response = await resolve(migration.id, 'ok');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true, status: 'ok', detail: 'Manually verified by an administrator after upstream reconciliation.',
  });
  const finished = await readMigration(migration.id);
  assert.equal(finished.status, 'ok');
  assert.equal(finished.status_detail, response.body.detail);
  assert.ok(finished.finished_at instanceof Date);
  assert.equal(finished.kept_source, true);
  assert.equal(finished.upstream_status, migration.upstream_status);
  assert.deepEqual(finished.upstream_checked_at, migration.upstream_checked_at);
  assert.deepEqual(finished.steps, steps.map((step) => ['active', 'pending'].includes(step.status) ? { ...step, status: 'done' } : step));

  for (const { table, row } of linked) {
    const [moved] = await testDb.db.select().from(table).where(eq(table.id, row.id));
    assert.deepEqual(moved, { ...row, node: targetNode });
  }
  for (const row of unrelated) {
    const [untouched] = await testDb.db.select().from(vmSshConfigs).where(eq(vmSshConfigs.id, row.id));
    assert.deepEqual(untouched, row);
  }
  const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.target, String(migration.id)));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'migration_operation_resolved');
  assert.equal(audits[0].detail, 'from=needs_review; to=ok');
  assert.equal((await resolve(migration.id, 'ok')).status, 409);
  assert.deepEqual(await readMigration(migration.id), finished);
});

test('manual adopt success preserves step outcomes and the leftover source flag', async () => {
  const migration = await seedMigration(303, 'needs_review', 'adopt');
  const linked = await seedLinkedRows(303);
  assert.equal((await resolve(migration.id, 'ok')).status, 200);
  const finished = await readMigration(migration.id);
  assert.equal(finished.status, 'ok');
  assert.equal(finished.kept_source, true);
  assert.deepEqual(finished.steps, steps);
  const [assignment] = await testDb.db.select().from(vmAssignments).where(eq(vmAssignments.id, linked[0].row.id));
  assert.equal(assignment.node, targetNode);
});

test('manual error resolution does not repoint rows or change step outcomes', async () => {
  const migration = await seedMigration(304);
  const linked = await seedLinkedRows(304);
  const response = await resolve(migration.id, 'error');
  assert.equal(response.status, 200);
  const finished = await readMigration(migration.id);
  assert.equal(finished.status, 'error');
  assert.equal(finished.status_detail, 'Marked failed by an administrator after upstream reconciliation.');
  assert.ok(finished.finished_at instanceof Date);
  assert.equal(finished.kept_source, true);
  assert.deepEqual(finished.steps, steps);
  for (const { table, row } of linked) {
    const [untouched] = await testDb.db.select().from(table).where(eq(table.id, row.id));
    assert.deepEqual(untouched, row);
  }
});

test('manual resolution rejects missing, invalid and non-review operations', async () => {
  assert.equal((await resolve(999999, 'ok')).status, 404);
  assert.equal((await resolve(999999, 'ready')).status, 400);
  for (const [index, status] of ['running', 'ok', 'error', 'failed', 'timeout'].entries()) {
    const migration = await seedMigration(310 + index, status);
    assert.equal((await resolve(migration.id, 'ok')).status, 409);
    assert.equal((await resolve(migration.id, 'error')).status, 409);
    assert.deepEqual(await readMigration(migration.id), migration);
  }
});

test('shared success finalizer claims running migrations once and cannot bypass review', async () => {
  const migration = await seedMigration(320, 'running');
  const linked = await seedLinkedRows(320);
  const outcomes = await Promise.all([
    finalizeMigrationSuccess(testDb.db, migration.id, 'Completed', { keptSource: false }),
    finalizeMigrationSuccess(testDb.db, migration.id, 'Completed', { keptSource: false }),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  const finished = await readMigration(migration.id);
  assert.equal(finished.status, 'ok');
  assert.equal(finished.kept_source, false);
  const [assignment] = await testDb.db.select().from(vmAssignments).where(eq(vmAssignments.id, linked[0].row.id));
  assert.equal(assignment.node, targetNode);
  assert.equal(await finalizeMigrationSuccess(testDb.db, migration.id, 'Duplicate'), false);
  assert.deepEqual(await readMigration(migration.id), finished);

  const review = await seedMigration(321);
  assert.equal(await finalizeMigrationSuccess(testDb.db, review.id), false);
  assert.deepEqual(await readMigration(review.id), review);
});

function failTemplateWrite(t) {
  const transaction = client.db.transaction.bind(client.db);
  t.mock.method(client.db, 'transaction', (callback) => transaction(async (tx) => {
    const update = tx.update.bind(tx);
    t.mock.method(tx, 'update', (table) => {
      if (table === vmTemplates) throw new Error('template write unavailable');
      return update(table);
    });
    return callback(tx);
  }));
}

test('repoint write failures roll back status, steps and all linked updates and allow retry', async (t) => {
  const migration = await seedMigration(330);
  const linked = await seedLinkedRows(330);
  const [conflict] = await testDb.db.insert(vmTemplates)
    .values({ node: targetNode, vmid: 330, name: 'existing-target-template' }).returning();
  failTemplateWrite(t);
  assert.equal((await resolve(migration.id, 'ok')).status, 500);
  assert.deepEqual(await readMigration(migration.id), migration);
  for (const { table, row } of linked) {
    const [untouched] = await testDb.db.select().from(table).where(eq(table.id, row.id));
    assert.deepEqual(untouched, row);
  }
  const [untouched] = await testDb.db.select().from(vmTemplates).where(eq(vmTemplates.id, conflict.id));
  assert.deepEqual(untouched, conflict);
  assert.deepEqual(await testDb.db.select().from(auditLog).where(eq(auditLog.target, String(migration.id))), []);

  t.mock.restoreAll();
  assert.equal((await resolve(migration.id, 'ok')).status, 200);
  assert.deepEqual(await testDb.db.select().from(vmTemplates).where(eq(vmTemplates.id, conflict.id)), []);
  assert.equal((await readMigration(migration.id)).status, 'ok');
  for (const { table, row } of linked) {
    const [moved] = await testDb.db.select().from(table).where(eq(table.id, row.id));
    assert.deepEqual(moved, { ...row, node: targetNode });
  }
});

test('concurrent manual success and failure resolutions cannot overwrite the winning outcome', async () => {
  const migration = await seedMigration(340);
  const linked = await seedLinkedRows(340);
  const responses = await Promise.all([resolve(migration.id, 'ok'), resolve(migration.id, 'error')]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = responses.find((response) => response.status === 200)!;
  const finished = await readMigration(migration.id);
  assert.equal(finished.status, winner.body.status);
  for (const { table, row } of linked) {
    const [persisted] = await testDb.db.select().from(table).where(eq(table.id, row.id));
    assert.deepEqual(persisted, { ...row, node: finished.status === 'ok' ? targetNode : row.node });
  }
});

for (const exitstatus of ['OK', 'ERROR']) {
  test(`stale reconciliation (${exitstatus}) cannot overwrite manual success or repointed policies`, async (t) => {
    const migration = await seedMigration(exitstatus === 'OK' ? 350 : 351);
    const linked = await seedLinkedRows(migration.vmid);
    await testDb.db.update(vmMigrations).set({ upid: 'UPID:source:reconcile' }).where(eq(vmMigrations.id, migration.id));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(https, 'request', (_url, _options, callback) => {
      const req = new EventEmitter() as any;
      req.setTimeout = () => {};
      req.write = () => {};
      req.destroy = () => {};
      req.end = async () => {
        entered.resolve();
        await release.promise;
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        callback(res);
        res.emit('data', JSON.stringify({ data: { status: 'stopped', exitstatus } }));
        res.emit('end');
      };
      return req;
    });
    const reconciliation = request(app).post(`/operations/migration/${migration.id}/reconcile`).then((response) => response);
    await entered.promise;
    let finished;
    try {
      assert.equal((await resolve(migration.id, 'ok')).status, 200);
      finished = await readMigration(migration.id);
    } finally {
      release.resolve();
    }
    assert.equal((await reconciliation).status, 409);
    assert.deepEqual(await readMigration(migration.id), finished);
    for (const { table, row } of linked) {
      const [persisted] = await testDb.db.select().from(table).where(eq(table.id, row.id));
      assert.deepEqual(persisted, { ...row, node: targetNode });
    }
    assert.equal((await resolve(migration.id, 'error')).status, 409);
    const audits = await testDb.db.select().from(auditLog).where(eq(auditLog.target, String(migration.id)));
    assert.deepEqual(audits.map((audit) => audit.action), ['migration_operation_resolved']);
  });
}

for (const mode of ['remote_migrate', 'adopt']) {
  test(`automatic ${mode} linked-row write failure becomes reviewable and manual verification can retry`, async (t) => {
    const migration = await seedMigration(mode === 'adopt' ? 361 : 360, 'running', mode);
    const linked = await seedLinkedRows(migration.vmid);
    const [conflict] = await testDb.db.insert(vmTemplates).values({
      node: targetNode, vmid: migration.vmid, name: 'conflicting-target',
    }).returning();
    failTemplateWrite(t);
    assert.equal(await finalizeMigration(migration.id, true, 'Physical move completed', { keptSource: true }), false);
    const review = await readMigration(migration.id);
    assert.equal(review.status, 'needs_review');
    assert.equal(review.upstream_status, 'stopped:OK');
    assert.match(review.status_detail || '', /Upstream migration completed.*bookkeeping failed/);
    assert.equal(review.kept_source, true);
    assert.deepEqual(review.steps, migration.steps);
    for (const { table, row } of linked) {
      const [persisted] = await testDb.db.select().from(table).where(eq(table.id, row.id));
      assert.deepEqual(persisted, row);
    }
    assert.equal((await resolve(migration.id, 'ok')).status, 500);
    assert.deepEqual(await readMigration(migration.id), review);
    t.mock.restoreAll();
    assert.equal((await resolve(migration.id, 'ok')).status, 200);
    assert.deepEqual(await testDb.db.select().from(vmTemplates).where(eq(vmTemplates.id, conflict.id)), []);
    assert.equal((await readMigration(migration.id)).status, 'ok');
  });
}

test('automatic success cannot escape into physical-failure handlers when saving review state also fails', async (t) => {
  const migration = await seedMigration(370, 'running', 'adopt');
  const linked = await seedLinkedRows(370);
  t.mock.method(client.db, 'transaction', async () => { throw new Error('database unavailable'); });
  t.mock.method(client.db, 'update', () => { throw new Error('database unavailable'); });
  assert.equal(await finalizeMigration(migration.id, true), false);
  assert.deepEqual(await readMigration(migration.id), migration);
  for (const { table, row } of linked) {
    const [persisted] = await testDb.db.select().from(table).where(eq(table.id, row.id));
    assert.deepEqual(persisted, row);
  }
});

test('reconciliation rejects running and terminal migrations before any upstream request', async (t) => {
  const upstream = t.mock.method(https, 'request', () => { throw new Error('must not request upstream'); });
  for (const [index, status] of ['running', 'ok', 'error'].entries()) {
    const migration = await seedMigration(380 + index, status);
    await testDb.db.update(vmMigrations).set({ upid: 'UPID:source:reconcile' }).where(eq(vmMigrations.id, migration.id));
    assert.equal((await request(app).post(`/operations/migration/${migration.id}/reconcile`)).status, 409);
  }
  assert.equal(upstream.mock.callCount(), 0);
});
