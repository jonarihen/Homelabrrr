import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { vmLeases, vmSchedules, vmMigrations } from '../db/schema/index.ts';
import express from 'express';
import request from 'supertest';
import { setTimeout as delay } from 'node:timers/promises';

let testDb: TestDatabase;
let client: typeof import('../db/client.ts');
let repointVmRows: typeof import('./migrate.ts').repointVmRows;
let finalizeMigrationSuccess: typeof import('./migrate.ts').finalizeMigrationSuccess;
let finalizeMigration: typeof import('./migrate.ts').finalizeMigration;
let createLeaseForVm: typeof import('../utils/leases.ts').createLeaseForVm;
let app: express.Express;

const lease = {
  lease_days: 14,
  started_at: new Date('2026-09-01T12:00:00Z'),
  expires_at: new Date('2026-09-15T12:00:00Z'),
  renewal_count: 3,
  last_renewed_at: new Date('2026-09-01T12:00:00Z'),
  exempt: true,
  expired: true,
  expired_at: new Date('2026-09-15T12:00:00Z'),
  auto_stopped: true,
  created_by: 'owner',
  created_at: new Date('2026-08-01T12:00:00Z'),
};
const schedule = {
  enabled: true,
  stop_time: '23:00',
  start_time: '07:00',
  days: 62,
  timezone: 'Europe/Copenhagen',
  skip_until: 1791000000000,
  running_due_to_manual: true,
  stopped_this_window: true,
  last_off: 1,
  last_action: 'stop:shutdown',
  last_action_at: 1790900000000,
  updated_at: new Date('2026-09-01T12:00:00Z'),
};

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  client = await import('../db/client.ts');
  ({ repointVmRows, finalizeMigrationSuccess, finalizeMigration } = await import('./migrate.ts'));
  ({ createLeaseForVm } = await import('../utils/leases.ts'));
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 1, isAdmin: true } as never;
    next();
  });
  app.use((await import('./vms.ts')).default);
});

after(async () => {
  await client.closeDb();
  await testDb.drop();
});

beforeEach(async () => {
  await testDb.db.delete(vmLeases);
  await testDb.db.delete(vmSchedules);
  await testDb.db.delete(vmMigrations);
});

async function seedPolicies(node: string, vmid = 101, source = false) {
  const [leaseRow] = await testDb.db.insert(vmLeases).values({
    node, vmid, ...(source ? lease : {}),
  }).returning();
  const [scheduleRow] = await testDb.db.insert(vmSchedules).values({
    node, vmid, ...(source ? schedule : {}),
  }).returning();
  return { lease: leaseRow, schedule: scheduleRow };
}

async function readPolicies(vmid = 101) {
  return {
    leases: await testDb.db.select().from(vmLeases).where(eq(vmLeases.vmid, vmid)).orderBy(vmLeases.id),
    schedules: await testDb.db.select().from(vmSchedules).where(eq(vmSchedules.vmid, vmid)).orderBy(vmSchedules.id),
  };
}

async function assertRepointed(source: Awaited<ReturnType<typeof seedPolicies>>, targetNode: string) {
  assert.deepEqual(await readPolicies(), {
    leases: [{ ...source.lease, node: targetNode }],
    schedules: [{ ...source.schedule, node: targetNode }],
  });
}

test('repoints qualified leases and schedules without changing policy or enforcement state', async () => {
  const source = await seedPolicies('1~pve1', 101, true);
  const unrelated = await seedPolicies('1~pve1', 102, true);
  await repointVmRows('1~pve1', '101', '2~pve2');
  await assertRepointed(source, '2~pve2');
  assert.deepEqual(await readPolicies(102), {
    leases: [unrelated.lease], schedules: [unrelated.schedule],
  });
});

test('repoints legacy bare leases and schedules even when both hosts use the same node name', async () => {
  const source = await seedPolicies('pve', 101, true);
  await repointVmRows('1~pve', 101, '2~pve');
  await assertRepointed(source, '2~pve');
  await repointVmRows('1~pve', 101, '2~pve');
  await assertRepointed(source, '2~pve');
});

test('qualified source policy wins over source aliases and target conflicts, leaving only one of each', async () => {
  await seedPolicies('pve1');
  await seedPolicies('2~pve2');
  const source = await seedPolicies('1~pve1', 101, true);
  await seedPolicies('pve2');
  const unrelated = await seedPolicies('3~pve1', 101, true);
  await repointVmRows('1~pve1', 101, '2~pve2');
  const expected = {
    leases: [{ ...source.lease, node: '2~pve2' }, unrelated.lease],
    schedules: [{ ...source.schedule, node: '2~pve2' }, unrelated.schedule],
  };
  assert.deepEqual(await readPolicies(), expected);
  await repointVmRows('1~pve1', 101, '2~pve2');
  assert.deepEqual(await readPolicies(), expected);
});

test('legacy source policy wins over qualified and bare target conflicts', async () => {
  await seedPolicies('2~pve2');
  const source = await seedPolicies('pve1', 101, true);
  await seedPolicies('pve2');
  await repointVmRows('1~pve1', 101, '2~pve2');
  await assertRepointed(source, '2~pve2');
});

test('does not delete existing target policies when no source policy exists', async () => {
  await seedPolicies('2~pve2', 101, true);
  await seedPolicies('pve2');
  const original = await readPolicies();
  await repointVmRows('1~pve1', 101, '2~pve2');
  assert.deepEqual(await readPolicies(), original);
});

test('concurrent repoints preserve one migrated lease and schedule', async () => {
  const source = await seedPolicies('1~pve1', 101, true);
  await seedPolicies('2~pve2');
  await Promise.all([
    repointVmRows('1~pve1', 101, '2~pve2'),
    repointVmRows('1~pve1', 101, '2~pve2'),
  ]);
  await assertRepointed(source, '2~pve2');
});

test('a schedule write failure rolls back lease moves and both conflict deletions', async (t) => {
  await seedPolicies('1~pve1', 101, true);
  await seedPolicies('2~pve2');
  const original = await readPolicies();
  const transaction = client.db.transaction.bind(client.db);
  t.mock.method(client.db, 'transaction', (callback) => transaction(async (tx) => {
    const update = tx.update.bind(tx);
    t.mock.method(tx, 'update', (table) => {
      if (table === vmSchedules) throw new Error('schedule write failed');
      return update(table);
    });
    return callback(tx);
  }));
  await assert.rejects(repointVmRows('1~pve1', 101, '2~pve2'), /schedule write failed/);
  assert.deepEqual(await readPolicies(), original);
});

async function seedMigration(mode = 'remote_migrate') {
  const [row] = await testDb.db.insert(vmMigrations).values({
    vmid: 101, source_node: '1~pve1', target_node: '2~pve2', mode,
    steps: [{ key: 'finalize', status: 'active' }],
  }).returning();
  return row;
}

for (const mode of ['remote_migrate', 'adopt']) {
  test(`${mode} bookkeeping failure rolls back success and leaves a reviewable retry`, async (t) => {
    const source = await seedPolicies('1~pve1', 101, true);
    await seedPolicies('2~pve2');
    const original = await readPolicies();
    const migration = await seedMigration(mode);
    const transaction = client.db.transaction.bind(client.db);
    t.mock.method(client.db, 'transaction', (callback) => transaction(async (tx) => {
      const update = tx.update.bind(tx);
      t.mock.method(tx, 'update', (table) => {
        if (table === vmSchedules) throw new Error('schedule write failed');
        return update(table);
      });
      return callback(tx);
    }));
    assert.equal(await finalizeMigration(migration.id, true), false);
    const [review] = await testDb.db.select().from(vmMigrations);
    assert.equal(review.status, 'needs_review');
    assert.equal(review.upstream_status, 'stopped:OK');
    assert.deepEqual(review.steps, migration.steps);
    assert.deepEqual(await readPolicies(), original);
    t.mock.restoreAll();
    assert.equal(await finalizeMigrationSuccess(client.db, migration.id, 'Verified', { expectedStatus: 'needs_review' }), true);
    await assertRepointed(source, '2~pve2');
    assert.equal(await finalizeMigrationSuccess(client.db, migration.id), false);
  });
}

async function waitForBlockedPolicyWrites() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await testDb.pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'");
    if (rows[0].count >= 2) return;
    await delay(10);
  }
  assert.fail('policy writers did not wait for the logical VM lock');
}

for (const existing of [false, true]) {
  test(`policy creation queued behind finalization cannot recreate the source key (existing=${existing})`, async (t) => {
    if (existing) await seedPolicies('1~pve1', 101, true);
    const migration = await seedMigration();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = testDb.db.transaction.bind(testDb.db);
    t.mock.method(testDb.db, 'transaction', (callback) => transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      t.mock.method(tx, 'execute', async (query) => {
        const result = await execute(query);
        locked.resolve();
        await release.promise;
        return result;
      });
      return callback(tx);
    }));
    const finalization = finalizeMigrationSuccess(testDb.db, migration.id);
    await locked.promise;
    const leaseWrite = createLeaseForVm('1~pve1', 101).then(() => null, (err) => err);
    const scheduleWrite = request(app).put('/1~pve1/101/schedule')
      .send({ stopTime: '23:00', startTime: '07:00' }).then((response) => response);
    try {
      await waitForBlockedPolicyWrites();
    } finally {
      release.resolve();
    }
    assert.equal(await finalization, true);
    assert.equal((await leaseWrite)?.statusCode, 409);
    assert.equal((await scheduleWrite).status, 409);
    const policies = await readPolicies();
    assert.equal(policies.leases.length, existing ? 1 : 0);
    assert.equal(policies.schedules.length, existing ? 1 : 0);
    assert.ok([...policies.leases, ...policies.schedules].every((row) => row.node === '2~pve2'));
  });
}

test('policy creation during a running migration is rejected and creation at the completed target succeeds', async () => {
  const migration = await seedMigration();
  await assert.rejects(createLeaseForVm('1~pve1', 101), { statusCode: 409 });
  assert.equal((await request(app).put('/1~pve1/101/schedule').send({ stopTime: '23:00', startTime: '07:00' })).status, 409);
  assert.equal(await finalizeMigrationSuccess(client.db, migration.id), true);
  assert.ok(await createLeaseForVm('2~pve2', 101));
  assert.equal((await request(app).put('/2~pve2/101/schedule').send({ stopTime: '23:00', startTime: '07:00' })).status, 200);
  assert.ok((await readPolicies()).leases.every((row) => row.node === '2~pve2'));
});

test('a bare source name shared by both hosts cannot recreate policy after migration', async () => {
  const [migration] = await testDb.db.insert(vmMigrations).values({
    vmid: 101, source_node: '1~pve', target_node: '2~pve', status: 'running',
  }).returning();
  await finalizeMigrationSuccess(client.db, migration.id);
  await assert.rejects(createLeaseForVm('pve', 101), { statusCode: 409 });
  assert.equal((await request(app).put('/pve/101/schedule').send({ stopTime: '23:00', startTime: '07:00' })).status, 409);
  assert.deepEqual(await readPolicies(), { leases: [], schedules: [] });
});
