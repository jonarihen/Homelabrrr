import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { vmLeases, vmSchedules, vmMigrations, users, vmAssignments, vmSshConfigs, vmSshUserConfigs, vmTemplates, provisionedVms, pveHosts } from '../db/schema/index.ts';
import https from 'node:https';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
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
let recordMigrationProgress: typeof import('./migrate.ts').recordMigrationProgress;
let recordMigrationStartFailure: typeof import('./migrate.ts').recordMigrationStartFailure;

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
  process.env.SECRET_ENCRYPTION_KEY ||= '44'.repeat(32);
  client = await import('../db/client.ts');
  ({ repointVmRows, finalizeMigrationSuccess, finalizeMigration, recordMigrationProgress, recordMigrationStartFailure } = await import('./migrate.ts'));
  process.env.SECRET_ENCRYPTION_KEY ||= '44'.repeat(32);
  await testDb.db.insert(users).values([
    { id: 1, username: 'migration-admin', password: 'x', is_admin: true },
    { id: 2, username: 'other-owner', password: 'x' },
  ]);
  ({ createLeaseForVm } = await import('../utils/leases.ts'));
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 1, isAdmin: true, username: 'migration-admin', reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/admin', (await import('./admin.ts')).default);
  app.use('/operations', (await import('./operations.ts')).default);
  app.use('/migrate', (await import('./migrate.ts')).default);
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
  await testDb.db.delete(provisionedVms);
  await testDb.db.delete(vmTemplates);
  await testDb.db.delete(vmAssignments);
  await testDb.db.delete(vmSshConfigs);
  await testDb.db.delete(vmSshUserConfigs);
  await testDb.db.delete(pveHosts);
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

test('automatic finalization remains contained when the database cannot persist review state', async (t) => {
  const migration = await seedMigration('adopt');
  await seedPolicies('1~pve1', 101, true);
  const original = await readPolicies();
  t.mock.method(client.db, 'transaction', async () => { throw new Error('database unavailable'); });
  t.mock.method(client.db, 'update', () => { throw new Error('database unavailable'); });
  assert.equal(await finalizeMigration(migration.id, true), false);
  assert.deepEqual((await testDb.db.select().from(vmMigrations))[0], migration);
  assert.deepEqual(await readPolicies(), original);
});

for (const status of ['running', 'needs_review']) {
  test(`admin lease adjustments and renewals preserve intentional 409 conflicts (${status})`, async () => {
    const migration = await seedMigration();
    await testDb.db.update(vmMigrations).set({ status }).where(eq(vmMigrations.id, migration.id));
    for (const response of [
      await request(app).put('/admin/leases/1~pve1/101').send({ leaseDays: 7 }),
      await request(app).post('/admin/leases/1~pve1/101/renew'),
    ]) {
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.match(response.body.error, /migration.*completion or review/i);
    }
    assert.deepEqual(await readPolicies(), { leases: [], schedules: [] });
  });
}

test('equivalent unambiguous bare target references support lease and schedule writes', async () => {
  const migration = await seedMigration();
  await finalizeMigrationSuccess(client.db, migration.id);
  assert.ok(await createLeaseForVm('pve2', 101));
  assert.equal((await request(app).post('/admin/leases/pve2/101/renew')).status, 200);
  assert.equal((await request(app).put('/pve2/101/schedule').send({ stopTime: '23:00', startTime: '07:00' })).status, 200);
  await assert.rejects(createLeaseForVm('1~pve2', 101), { statusCode: 409 });
  await createLeaseForVm('2~pve2', 101);
  await request(app).put('/2~pve2/101/schedule').send({ stopTime: '22:00', startTime: '07:00' });
  const policies = await readPolicies();
  assert.equal(policies.leases.length, 1);
  assert.equal(policies.schedules.length, 1);
  assert.equal(policies.leases[0].node, '2~pve2');
  assert.equal(policies.schedules[0].node, '2~pve2');
});

test('manual production verification repoints lease and schedule after bookkeeping review', async () => {
  const source = await seedPolicies('1~pve1', 101, true);
  const migration = await seedMigration();
  await testDb.db.update(vmMigrations).set({ status: 'needs_review' }).where(eq(vmMigrations.id, migration.id));
  const response = await request(app).post(`/operations/migration/${migration.id}/resolve`).send({ status: 'ok' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await assertRepointed(source, '2~pve2');
  assert.equal((await request(app).post(`/operations/migration/${migration.id}/resolve`).send({ status: 'error' })).status, 409);
});

test('all unique linked tables collapse qualified/bare aliases and target conflicts while retaining source identity', async () => {
  const migration = await seedMigration();
  for (const table of [vmAssignments, vmSshConfigs, vmSshUserConfigs, vmTemplates] as any[]) {
    const values = (node, userId = 1) => ({ node, vmid: 101,
      ...(table === vmAssignments || table === vmSshUserConfigs ? { user_id: userId } : {}),
      ...(table === vmSshConfigs ? { host: '192.0.2.1' } : {}),
      ...(table === vmTemplates ? { name: node } : {}),
    });
    const [source] = await testDb.db.insert(table).values(values('1~pve1')).returning();
    const duplicates = await testDb.db.insert(table).values(['pve1', '2~pve2', 'pve2'].map((node) => values(node))).returning();
    const [unrelated] = await testDb.db.insert(table).values(values('3~pve1')).returning();
    if (table === vmTemplates) {
      for (const row of [source, ...duplicates]) {
        await testDb.db.insert(provisionedVms).values({ user_id: 1, node: row.node, vmid: 101, name: 'history', template_id: row.id });
      }
    }
    let otherSource;
    if (table === vmSshUserConfigs) {
      [otherSource] = await testDb.db.insert(table).values(values('pve1', 2)).returning();
      await testDb.db.insert(table).values(values('2~pve2', 2));
    }
    await repointVmRows('1~pve1', 101, '2~pve2');
    const rows = await testDb.db.select().from(table).orderBy(table.id);
    assert.deepEqual(rows, [{ ...source, node: '2~pve2' }, unrelated, ...(otherSource ? [{ ...otherSource, node: '2~pve2' }] : [])]);
    if (table === vmTemplates) {
      assert.ok((await testDb.db.select().from(provisionedVms)).every((row) => row.template_id === source.id));
    }
  }
  assert.equal(await finalizeMigrationSuccess(client.db, migration.id), true);
});

test('progress queued behind finalization cannot resurrect a terminal step or offset', async (t) => {
  const migration = await seedMigration();
  const claimed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transaction = testDb.db.transaction.bind(testDb.db);
  t.mock.method(testDb.db, 'transaction', (callback) => transaction(async (tx) => {
    const update = tx.update.bind(tx);
    t.mock.method(tx, 'update', (table) => {
      const builder = update(table);
      if (table !== vmMigrations) return builder;
      const set = builder.set.bind(builder);
      builder.set = (values) => {
        const query = set(values);
        if (values.status !== 'ok') return query;
        const returning = query.returning.bind(query);
        query.returning = async () => {
          const rows = await returning();
          claimed.resolve();
          await release.promise;
          return rows;
        };
        return query;
      };
      return builder;
    });
    return callback(tx);
  }));
  const finish = finalizeMigrationSuccess(testDb.db, migration.id);
  await claimed.promise;
  const progress = recordMigrationProgress(migration.id, { log_offset: 99, progress: 70, progress_detail: 'copying' }, { key: 'finalize', note: 'stale' });
  release.resolve();
  assert.equal(await finish, true);
  await progress;
  const [row] = await testDb.db.select().from(vmMigrations);
  assert.equal(row.status, 'ok');
  assert.equal(row.log_offset, 0);
  assert.equal(row.progress, null);
  assert.deepEqual(row.steps, [{ key: 'finalize', status: 'done' }]);
});

test('deleting a migrated guest removes obsolete location history so its VMID can be reused', async (t) => {
  const migration = await seedMigration();
  await finalizeMigrationSuccess(client.db, migration.id);
  const { encryptSecret } = await import('../utils/secrets.ts');
  await testDb.db.insert(pveHosts).values({ id: 2, name: 'target', host: 'target.invalid', token_id: 'test', token_secret: encryptSecret('test'), verify_tls: true });
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter() as any;
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (err) => req.emit('error', err);
    req.end = () => {
      const data = url.pathname.endsWith('/status/current') ? { status: 'stopped' }
        : url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' }
          : options.method === 'DELETE' ? 'UPID:pve2:delete' : [];
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      callback(res);
      res.emit('data', JSON.stringify({ data }));
      res.emit('end');
    };
    return req;
  });
  const response = await request(app).delete('/2~pve2/101');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(await testDb.db.select().from(vmMigrations), []);
  const replacement = await createLeaseForVm('3~replacement', 101);
  assert.equal(replacement?.node, '3~replacement');
});

function mockUpstream(t, respond) {
  return t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter() as any;
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (err) => req.emit('error', err);
    req.end = () => {
      void Promise.resolve(respond(url, options)).then(({ statusCode = 200, data }) => {
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;
        callback(res);
        res.emit('data', JSON.stringify({ data }));
        res.emit('end');
      }).catch((err) => req.emit('error', err));
    };
    return req;
  });
}

async function seedHost(id = 1) {
  const { encryptSecret } = await import('../utils/secrets.ts');
  await testDb.db.insert(pveHosts).values({ id, name: `host-${id}`, host: 'pve.invalid', token_id: 'test', token_secret: encryptSecret('test'), verify_tls: true });
}

for (const status of ['running', 'needs_review']) {
  test(`deletion rejects ${status} migrations before any Proxmox operation`, async (t) => {
    const migration = await seedMigration('adopt');
    await testDb.db.update(vmMigrations).set({ status }).where(eq(vmMigrations.id, migration.id));
    const original = (await testDb.db.select().from(vmMigrations))[0];
    const upstream = mockUpstream(t, () => { throw new Error('must not contact upstream'); });
    assert.equal((await request(app).delete('/1~pve1/101')).status, 409);
    assert.equal(upstream.mock.callCount(), 0);
    assert.deepEqual((await testDb.db.select().from(vmMigrations))[0], original);
  });
}

for (const source of ['pve', '1~pve']) {
  test(`qualified deletion protects kept source stored as ${source}`, async (t) => {
    await testDb.db.insert(vmMigrations).values({ vmid: 101, source_node: source, target_node: '2~pve', status: 'ok', kept_source: true });
    const upstream = mockUpstream(t, () => { throw new Error('must not contact upstream'); });
    assert.equal((await request(app).delete('/1~pve/101')).status, 400);
    assert.equal(upstream.mock.callCount(), 0);
  });
}

test('qualified target deletion is allowed when a legacy kept source has the same bare node name', async (t) => {
  await seedHost(2);
  await testDb.db.insert(vmMigrations).values({ vmid: 101, source_node: 'pve', target_node: '2~pve', status: 'ok', kept_source: true });
  mockUpstream(t, (url, options) => ({ data: options.method === 'DELETE' ? 'UPID:pve:delete'
    : url.pathname.endsWith('/status/current') ? { status: 'stopped' }
      : url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] }));
  assert.equal((await request(app).delete('/2~pve/101')).status, 200);
});

test('migration registration waits for deletion from before its first upstream request through cleanup', async (t) => {
  await seedHost();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  mockUpstream(t, async (url, options) => {
    if (options.method === 'DELETE') { entered.resolve(); await release.promise; return { data: 'UPID:pve1:delete' }; }
    return { data: url.pathname.endsWith('/status/current') ? { status: 'stopped' }
      : url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  const deleting = request(app).delete('/1~pve1/101').then((response) => response);
  await entered.promise;
  const { withVmMigrationLock } = await import('../utils/vmMigrationLock.ts');
  let registered = false;
  const registering = withVmMigrationLock(101, async () => { registered = true; });
  try {
    for (let i = 0; i < 200 && !registered; i++) {
      const { rows } = await testDb.pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'");
      if (rows[0].count > 0) break;
      await delay(10);
    }
    assert.equal(registered, false);
  } finally { release.resolve(); }
  assert.equal((await deleting).status, 200);
  await registering;
  assert.equal(registered, true);
});

test('cleanup retries after irreversible deletion and does not treat unreachable hosts as absent', async (t) => {
  await seedHost(2);
  const migration = await seedMigration();
  await finalizeMigrationSuccess(client.db, migration.id);
  await seedPolicies('2~pve2');
  let absent = false;
  let deletes = 0;
  mockUpstream(t, (url, options) => {
    if (url.pathname.endsWith('/status/current')) return { statusCode: absent ? 404 : 200, data: absent ? null : { status: 'stopped' } };
    if (options.method === 'DELETE') { absent = true; deletes++; return { data: 'UPID:pve1:delete' }; }
    return { data: url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  const originalConnect = client.pool.connect.bind(client.pool);
  const connect = t.mock.method(client.pool, 'connect', async (...args) => {
    const connection = await originalConnect(...args);
    const query = connection.query.bind(connection);
    connection.query = (...queryArgs) => {
      if (queryArgs[0]?.text?.startsWith('delete from "vm_migrations"')) throw new Error('cleanup unavailable');
      return query(...queryArgs);
    };
    const release = connection.release.bind(connection);
    connection.release = (...releaseArgs) => { connection.query = query; return release(...releaseArgs); };
    return connection;
  });
  assert.equal((await request(app).delete('/2~pve2/101')).status, 500);
  assert.equal(deletes, 1);
  assert.equal((await testDb.db.select().from(vmMigrations)).length, 1);
  connect.mock.restore();
  const retry = await request(app).delete('/2~pve2/101');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.alreadyAbsent, true);
  assert.equal(deletes, 1);
  assert.deepEqual(await testDb.db.select().from(vmMigrations), []);
  assert.ok(await createLeaseForVm('3~replacement', 101));
  t.mock.restoreAll();
  mockUpstream(t, () => { throw new Error('connection unavailable'); });
  const failed = await seedMigration();
  await testDb.db.update(vmMigrations).set({ status: 'ok' }).where(eq(vmMigrations.id, failed.id));
  assert.equal((await request(app).delete('/2~pve2/101')).status, 500);
  assert.equal((await testDb.db.select().from(vmMigrations)).length, 1);
});

test('ambiguous migration submissions retain review protection; known pre-submit failures are terminal', async () => {
  const migration = await seedMigration();
  await recordMigrationStartFailure(migration.id, true);
  const [row] = await testDb.db.select().from(vmMigrations);
  assert.equal(row.status, 'needs_review');
  assert.equal(row.upstream_status, 'submission:unknown');
  await assert.rejects(createLeaseForVm('1~pve1', 101), { statusCode: 409 });
  assert.equal((await request(app).delete('/1~pve1/101')).status, 409);
  const [second] = await testDb.db.insert(vmMigrations).values({ vmid: 102, source_node: '1~pve1', target_node: '2~pve2' }).returning();
  await recordMigrationStartFailure(second.id, false);
  assert.equal((await testDb.db.select().from(vmMigrations).where(eq(vmMigrations.id, second.id)))[0].status, 'error');
});

test('a lost remote-migrate response leaves the claimed operation reviewable and blocks retry', async (t) => {
  await seedHost();
  await seedHost(2);
  t.mock.method(tls, 'connect', (_options, callback) => {
    const socket = new EventEmitter() as any;
    socket.getPeerCertificate = () => ({ fingerprint256: 'AA:BB' });
    socket.end = () => {};
    socket.setTimeout = () => {};
    queueMicrotask(callback);
    return socket;
  });
  let submissions = 0;
  mockUpstream(t, (url) => {
    if (url.pathname.endsWith('/remote_migrate')) { submissions++; throw new Error('response connection lost'); }
    if (url.pathname.endsWith('/cluster/resources')) return { data: [{ vmid: 101, node: 'pve1', type: 'qemu', status: 'stopped' }] };
    if (url.pathname.endsWith('/config')) return { data: {} };
    if (url.pathname.endsWith('/status')) return { data: { memory: { total: 1e12, free: 1e12 } } };
    return { data: [] };
  });
  const response = await request(app).post('/migrate/1~pve1/101').send({ targetNode: '2~pve2', targetStorage: 'local', targetBridge: 'vmbr0' });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  assert.equal(submissions, 1);
  const [row] = await testDb.db.select().from(vmMigrations);
  assert.equal(row.status, 'needs_review');
  assert.equal(row.upstream_status, 'submission:unknown');
  assert.equal((await request(app).post('/migrate/1~pve1/101').send({ targetNode: '2~pve2', targetStorage: 'local', targetBridge: 'vmbr0' })).status, 409);
  assert.equal(submissions, 1);
});

for (const task of [{ status: 'running' }, { status: 'stopped', exitstatus: 'ERROR' }]) {
  test(`manual success rejects upstream ${JSON.stringify(task)} without moving records`, async (t) => {
    await seedHost();
    const migration = await seedMigration();
    await testDb.db.update(vmMigrations).set({ status: 'needs_review', upid: 'UPID:pve1:test' }).where(eq(vmMigrations.id, migration.id));
    const original = (await testDb.db.select().from(vmMigrations))[0];
    const source = await seedPolicies('1~pve1', 101, true);
    mockUpstream(t, () => ({ data: task }));
    assert.equal((await request(app).post(`/operations/migration/${migration.id}/resolve`).send({ status: 'ok' })).status, 409);
    assert.deepEqual((await testDb.db.select().from(vmMigrations))[0], original);
    assert.deepEqual(await readPolicies(), { leases: [source.lease], schedules: [source.schedule] });
    t.mock.restoreAll();
    mockUpstream(t, () => ({ data: { status: 'stopped', exitstatus: 'OK' } }));
    assert.equal((await request(app).post(`/operations/migration/${migration.id}/resolve`).send({ status: 'ok' })).status, 200);
    await assertRepointed(source, '2~pve2');
  });
}
