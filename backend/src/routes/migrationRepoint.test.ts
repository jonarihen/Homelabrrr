import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { vmLeases, vmSchedules, vmMigrations, users, vmAssignments, vmSshConfigs, vmSshUserConfigs, vmTemplates, provisionedVms, pveHosts, publicIpAssignments, publicIpPools, publicIps, firewalls, backupTasks } from '../db/schema/index.ts';
import https from 'node:https';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';

let testDb: TestDatabase;
let client: typeof import('../db/client.ts');
let repointVmRows: typeof import('./migrate.ts').repointVmRows;
let finalizeMigrationSuccess: typeof import('./migrate.ts').finalizeMigrationSuccess;
let finalizeMigration: typeof import('./migrate.ts').finalizeMigration;
let createLeaseForVm: typeof import('../utils/leases.ts').createLeaseForVm;
let app: express.Express;
let ownerApp: express.Express;
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
  app.use('/ssh', (await import('./ssh.ts')).default);
  const vmRouter = (await import('./vms.ts')).default;
  app.use(vmRouter);
  ownerApp = express();
  ownerApp.use(express.json());
  ownerApp.use((req, _res, next) => {
    req.session = { userId: 2, isAdmin: false, username: 'other-owner' } as never;
    next();
  });
  ownerApp.use(vmRouter);
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
  await testDb.db.delete(publicIpAssignments);
  await testDb.db.delete(publicIps);
  await testDb.db.delete(publicIpPools);
  await testDb.db.delete(firewalls);
  await testDb.db.delete(backupTasks);
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
  const outcomes = await Promise.allSettled([
    repointVmRows('1~pve1', 101, '2~pve2'),
    repointVmRows('1~pve1', 101, '2~pve2'),
  ]);
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.statusCode, 409);
  await repointVmRows('1~pve1', 101, '2~pve2');
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

for (const existing of [false, true]) {
  test(`contended policy creation rejects without recreating the source key (existing=${existing})`, async (t) => {
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
      assert.equal((await leaseWrite)?.statusCode, 409);
      assert.equal((await scheduleWrite).status, 409);
    } finally { release.resolve(); }
    assert.equal(await finalization, true);
    const policies = await readPolicies();
    assert.equal(policies.leases.length, existing ? 1 : 0);
    assert.equal(policies.schedules.length, existing ? 1 : 0);
    assert.ok([...policies.leases, ...policies.schedules].every((row) => row.node === '2~pve2'));
  });
}

test('policy creation during a running migration is rejected and creation at the completed target succeeds', async (t) => {
  await seedHost(2);
  mockUpstream(t, () => ({ data: { status: 'stopped' } }));
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

test('equivalent unambiguous bare target references support lease and schedule writes', async (t) => {
  await seedHost(2);
  mockUpstream(t, () => ({ data: { status: 'stopped' } }));
  const migration = await seedMigration();
  await finalizeMigrationSuccess(client.db, migration.id);
  assert.ok(await createLeaseForVm('pve2', 101));
  assert.equal((await request(app).post('/admin/leases/pve2/101/renew')).status, 200);
  assert.equal((await request(app).put('/pve2/101/schedule').send({ stopTime: '23:00', startTime: '07:00' })).status, 200);
  await assert.rejects(createLeaseForVm('1~pve1', 101), { statusCode: 409 });
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

test('migration registration rejects contention throughout deletion and succeeds after cleanup', async (t) => {
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
  try {
    await assert.rejects(withVmMigrationLock(101, async () => { registered = true; }), { statusCode: 409 });
    assert.equal(registered, false);
  } finally { release.resolve(); }
  assert.equal((await deleting).status, 200);
  await withVmMigrationLock(101, async () => { registered = true; });
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

test('a losing migration cannot mutate or restore media while the winner prepares the source', async (t) => {
  await seedHost();
  await seedHost(2);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let configWrites = 0;
  let detached = false;
  mockUpstream(t, async (url, options) => {
    if (url.pathname.endsWith('/cluster/resources')) return { data: [{ vmid: 101, node: 'pve1', type: 'qemu', status: 'stopped' }] };
    if (options.method === 'PUT') {
      configWrites++;
      entered.resolve();
      await release.promise;
      detached = true;
      return { data: null };
    }
    if (url.pathname.endsWith('/config')) return { data: { ide2: detached ? 'none,media=cdrom' : 'local:iso/test.iso,media=cdrom' } };
    if (url.pathname.endsWith('/status')) return { data: { memory: { total: 1e12, free: 1e12 } } };
    return { data: [] };
  });
  t.mock.method(tls, 'connect', () => { throw new Error('pre-submit certificate lookup failed'); });
  const body = { targetNode: '2~pve2', targetStorage: 'local', targetBridge: 'vmbr0' };
  const winning = request(app).post('/migrate/1~pve1/101').send(body).then((response) => response);
  await entered.promise;
  try {
    assert.equal((await request(app).post('/migrate/1~pve1/101').send(body)).status, 409);
    assert.equal(configWrites, 1);
  } finally { release.resolve(); }
  assert.equal((await winning).status, 500);
  assert.equal(configWrites, 2, 'only winner detaches and restores its own media');
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

test('bare target deletion cleans canonical policies and does not let late admin writes recreate them', async (t) => {
  await seedHost(2);
  const migration = await seedMigration();
  const source = await seedPolicies('1~pve1', 101, true);
  await finalizeMigrationSuccess(client.db, migration.id);
  let absent = false;
  mockUpstream(t, (url, options) => {
    if (options.method === 'DELETE') { absent = true; return { data: 'UPID:pve2:delete' }; }
    if (url.pathname.endsWith('/status/current')) return { statusCode: absent ? 404 : 200, data: absent ? null : { status: 'stopped' } };
    return { data: url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  assert.equal((await request(app).delete('/pve2/101')).status, 200);
  assert.deepEqual(await readPolicies(), { leases: [], schedules: [] });
  assert.deepEqual(await testDb.db.select().from(vmMigrations), []);
  assert.equal((await request(app).post('/admin/leases/2~pve2/101/renew')).status, 404);
  assert.equal((await request(app).put('/2~pve2/101/schedule').send({ stopTime: '23:00', startTime: '07:00' })).status, 404);
  assert.deepEqual(await readPolicies(), { leases: [], schedules: [] });
  assert.ok(source.lease.id);
});

test('a delayed authorized policy request cannot recreate rows after deletion releases its lock', async (t) => {
  await seedHost();
  await seedPolicies('1~pve1');
  let absent = false;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  mockUpstream(t, (url, options) => {
    if (options.method === 'DELETE') { absent = true; return { data: 'UPID:pve1:delete' }; }
    if (url.pathname.endsWith('/status/current')) return { statusCode: absent ? 404 : 200, data: absent ? null : { status: 'stopped' } };
    return { data: url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  const { withVmPolicyWrite } = await import('../utils/vmMigrationLock.ts');
  const authorizedRequest = (async () => {
    entered.resolve();
    await resume.promise;
    return withVmPolicyWrite('1~pve1', 101, async (tx) => tx.insert(vmSchedules).values({ node: '1~pve1', vmid: 101 }), { userId: 1 });
  })();
  await entered.promise;
  assert.equal((await request(app).delete('/1~pve1/101')).status, 200);
  resume.resolve();
  await assert.rejects(authorizedRequest, { statusCode: 404 });
  assert.deepEqual(await readPolicies(), { leases: [], schedules: [] });
});

test('policy authorization is revalidated under the lock rather than trusting an earlier assignment', async (t) => {
  await seedHost();
  mockUpstream(t, () => ({ data: { status: 'stopped' } }));
  const { renewLease } = await import('../utils/leases.ts');
  await testDb.db.insert(vmAssignments).values({ user_id: 2, node: '1~pve1', vmid: 101 });
  await testDb.db.delete(vmAssignments);
  await assert.rejects(renewLease('1~pve1', 101, { actor: { userId: 2 } }), { statusCode: 403 });
  assert.deepEqual(await readPolicies(), { leases: [], schedules: [] });
});

async function seedLegacyOwnerVm() {
  const [assignment] = await testDb.db.insert(vmAssignments).values({ user_id: 2, node: 'pve', vmid: 101 }).returning();
  const [provisioning] = await testDb.db.insert(provisionedVms).values({ user_id: 2, node: 'pve', vmid: 101, name: 'legacy', status: 'ready' }).returning();
  const policies = await seedPolicies('pve');
  return { assignment, provisioning, policies };
}

async function mockLegacyHosts(t, { second = true, liveHosts = [1], unreachable = null }: { second?: boolean; liveHosts?: number[]; unreachable?: number | null } = {}) {
  await seedHost();
  if (second) await seedHost(2);
  await testDb.db.update(pveHosts).set({ host: 'host-1.invalid' }).where(eq(pveHosts.id, 1));
  if (second) await testDb.db.update(pveHosts).set({ host: 'host-2.invalid' }).where(eq(pveHosts.id, 2));
  const writes: number[] = [];
  const alive = new Set(liveHosts);
  mockUpstream(t, (url, options) => {
    const host = url.hostname === 'host-1.invalid' ? 1 : 2;
    if (host === unreachable) throw new Error('host unreachable');
    if (url.pathname.endsWith('/nodes')) return { data: [{ node: 'pve' }] };
    if (url.pathname.endsWith('/status/current')) return { statusCode: alive.has(host) ? 200 : 404, data: alive.has(host) ? { status: 'stopped' } : null };
    if (options.method !== 'GET') writes.push(host);
    if (options.method === 'DELETE') { alive.delete(host); return { data: 'UPID:pve:delete' }; }
    return { data: url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  return writes;
}

test('wrong qualified host absence cannot remove a legacy owner assignment or its quota tracking', async (t) => {
  const legacy = await seedLegacyOwnerVm();
  const writes = await mockLegacyHosts(t);
  const response = await request(ownerApp).delete('/2~pve/101');
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(writes, []);
  assert.deepEqual((await testDb.db.select().from(vmAssignments))[0], legacy.assignment);
  assert.deepEqual((await testDb.db.select().from(provisionedVms))[0], legacy.provisioning);
  assert.deepEqual(await readPolicies(), { leases: [legacy.policies.lease], schedules: [legacy.policies.schedule] });
});

test('correct qualified host deletion verifies and binds legacy records while preserving another host location', async (t) => {
  await seedLegacyOwnerVm();
  const [other] = await testDb.db.insert(vmAssignments).values({ user_id: 1, node: '2~pve', vmid: 101 }).returning();
  const writes = await mockLegacyHosts(t);
  const response = await request(ownerApp).delete('/1~pve/101');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(writes, [1]);
  assert.deepEqual(await testDb.db.select().from(vmAssignments), [other]);
  assert.deepEqual(await testDb.db.select().from(provisionedVms), []);
  assert.deepEqual(await readPolicies(), { leases: [], schedules: [] });
});

test('conflicting legacy and qualified owner aliases fail closed without dropping either assignment', async (t) => {
  const legacy = await seedLegacyOwnerVm();
  const [qualified] = await testDb.db.insert(vmAssignments).values({ user_id: 1, node: '1~pve', vmid: 101 }).returning();
  const writes = await mockLegacyHosts(t);
  const response = await request(ownerApp).delete('/1~pve/101');
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(writes, []);
  assert.deepEqual(await testDb.db.select().from(vmAssignments).orderBy(vmAssignments.id), [legacy.assignment, qualified]);
  assert.deepEqual((await testDb.db.select().from(provisionedVms))[0], legacy.provisioning);
});

test('legacy bare deletion and confirmed-missing cleanup work with one verified node host', async (t) => {
  await seedLegacyOwnerVm();
  const writes = await mockLegacyHosts(t, { second: false, liveHosts: [] });
  const response = await request(ownerApp).delete('/pve/101');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.alreadyAbsent, true);
  assert.deepEqual(writes, []);
  assert.deepEqual(await testDb.db.select().from(vmAssignments), []);
  assert.deepEqual(await testDb.db.select().from(provisionedVms), []);
});

for (const scenario of [{ liveHosts: [1, 2] }, { liveHosts: [] }, { liveHosts: [1], unreachable: 2 }]) {
  test(`legacy deletion fails closed for unresolved hosts ${JSON.stringify(scenario)}`, async (t) => {
    const legacy = await seedLegacyOwnerVm();
    const writes = await mockLegacyHosts(t, scenario);
    const response = await request(ownerApp).delete('/1~pve/101');
    assert.equal(response.status, scenario.unreachable ? 500 : 409, JSON.stringify(response.body));
    assert.deepEqual(writes, []);
    assert.deepEqual((await testDb.db.select().from(vmAssignments))[0], legacy.assignment);
    assert.deepEqual((await testDb.db.select().from(provisionedVms))[0], legacy.provisioning);
  });
}

test('verified legacy binding survives a cleanup failure so retry uses an exact host', async (t) => {
  await seedLegacyOwnerVm();
  const writes = await mockLegacyHosts(t);
  const connect = client.pool.connect.bind(client.pool);
  const mocked = t.mock.method(client.pool, 'connect', async (...args) => {
    if (typeof args[0] === 'function') return connect(...args);
    const connection = await connect(...args);
    const query = connection.query.bind(connection);
    connection.query = (...queryArgs) => {
      if (queryArgs[0]?.text?.startsWith('delete from "vm_assignments"')) throw new Error('cleanup unavailable');
      return query(...queryArgs);
    };
    const release = connection.release.bind(connection);
    connection.release = (...releaseArgs) => { connection.query = query; return release(...releaseArgs); };
    return connection;
  });
  assert.equal((await request(ownerApp).delete('/1~pve/101')).status, 500);
  assert.deepEqual(writes, [1]);
  assert.equal((await testDb.db.select().from(vmAssignments))[0].node, '1~pve');
  mocked.mock.restore();
  const retry = await request(ownerApp).delete('/1~pve/101');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.alreadyAbsent, true);
  assert.deepEqual(writes, [1]);
  assert.deepEqual(await testDb.db.select().from(vmAssignments), []);
});

test('SSH configuration writes reject deletion contention and cannot recreate a deleted bare alias', async (t) => {
  await seedHost();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let absent = false;
  mockUpstream(t, async (url, options) => {
    if (options.method === 'DELETE') { entered.resolve(); await release.promise; absent = true; return { data: 'UPID:pve:delete' }; }
    if (url.pathname.endsWith('/nodes')) return { data: [{ node: 'pve' }] };
    if (url.pathname.endsWith('/status/current')) return { statusCode: absent ? 404 : 200, data: absent ? null : { status: 'stopped' } };
    return { data: url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  const deleting = request(app).delete('/1~pve/101').then((response) => response);
  await entered.promise;
  const body = { host: '192.0.2.10', username: 'guest', hostFingerprint: 'SHA256:test' };
  try {
    assert.equal((await request(app).put('/ssh/config/pve/101').send(body)).status, 409);
    assert.deepEqual(await testDb.db.select().from(vmSshConfigs), []);
    assert.deepEqual(await testDb.db.select().from(vmSshUserConfigs), []);
  } finally { release.resolve(); }
  assert.equal((await deleting).status, 200);
  assert.equal((await request(app).put('/ssh/config/pve/101').send(body)).status, 404);
  assert.deepEqual(await testDb.db.select().from(vmSshConfigs), []);
  assert.deepEqual(await testDb.db.select().from(vmSshUserConfigs), []);
});

test('SSH operator grants are preserved and revocation is rechecked using the held database', async (t) => {
  await seedHost();
  mockUpstream(t, () => ({ data: { status: 'stopped' } }));
  const { withVmPolicyWrite } = await import('../utils/vmMigrationLock.ts');
  await testDb.db.update(users).set({ can_operate_all_vms: true }).where(eq(users.id, 2));
  try {
    assert.equal(await withVmPolicyWrite('1~pve1', 101, async () => true, { userId: 2, op: 'vm.sshConfig.write' }), true);
    await testDb.db.update(users).set({ can_operate_all_vms: false }).where(eq(users.id, 2));
    await assert.rejects(withVmPolicyWrite('1~pve1', 101, async () => true, { userId: 2, op: 'vm.sshConfig.write' }), { statusCode: 403 });
  } finally {
    await testDb.db.update(users).set({ can_operate_all_vms: false }).where(eq(users.id, 2));
  }
});

test('cleanup atomically rejects unexpected bare rows inserted by any current-location writer during deletion', async (t) => {
  await seedHost();
  const canonical = await seedPolicies('1~pve', 101, true);
  await testDb.db.insert(vmAssignments).values({ user_id: 1, node: '1~pve', vmid: 101 });
  let injected = false;
  mockUpstream(t, async (url, options) => {
    if (options.method === 'DELETE') {
      await testDb.db.insert(vmAssignments).values({ user_id: 2, node: 'pve', vmid: 101 });
      await testDb.db.insert(vmSshConfigs).values({ node: 'pve', vmid: 101, host: '192.0.2.10' });
      await testDb.db.insert(vmSshUserConfigs).values({ user_id: 1, node: 'pve', vmid: 101, username: 'guest' });
      await testDb.db.insert(provisionedVms).values({ user_id: 1, node: 'pve', vmid: 101, name: 'late' });
      await seedPolicies('pve');
      injected = true;
      return { data: 'UPID:pve:delete' };
    }
    return { data: url.pathname.endsWith('/status/current') ? { status: 'stopped' }
      : url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  const response = await request(app).delete('/1~pve/101');
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(injected, true);
  assert.equal((await testDb.db.select().from(vmAssignments)).length, 2);
  assert.deepEqual((await testDb.db.select().from(vmLeases).where(eq(vmLeases.id, canonical.lease.id)))[0], canonical.lease);
  assert.equal((await testDb.db.select().from(vmSshConfigs))[0].node, 'pve');
  assert.equal((await testDb.db.select().from(provisionedVms))[0].node, 'pve');
});

test('historical bare backup tasks do not make a known adopted target ambiguous or get rebound on deletion', async (t) => {
  await seedHost();
  await seedHost(2);
  await testDb.db.insert(vmMigrations).values({ vmid: 101, source_node: '1~pve', target_node: '2~pve', status: 'ok', mode: 'adopt', kept_source: true });
  const [history] = await testDb.db.insert(backupTasks).values({ node: 'pve', vmid: 101, upid: 'UPID:pve:old', status: 'ok' }).returning();
  let deleted = false;
  let nodeInventory = 0;
  mockUpstream(t, (url, options) => {
    if (url.pathname.endsWith('/nodes')) { nodeInventory++; return { data: [{ node: 'pve' }] }; }
    if (options.method === 'DELETE') { deleted = true; return { data: 'UPID:pve:delete' }; }
    return { data: url.pathname.endsWith('/status/current') ? { status: 'stopped' }
      : url.pathname.includes('/tasks/') ? { status: 'stopped', exitstatus: 'OK' } : [] };
  });
  const response = await request(app).delete('/2~pve/101');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(deleted, true);
  assert.equal(nodeInventory, 0);
  assert.deepEqual(await testDb.db.select().from(backupTasks), []);
  assert.equal(history.node, 'pve');
});

for (const releaseEarly of [true, false]) {
  test(`automatic adopt finalization retries contention outside the pool and stays reviewable if exhausted (release=${releaseEarly})`, async (t) => {
    const migration = await seedMigration('adopt');
    const source = await seedPolicies('1~pve1', 101, true);
    const blocker = await testDb.pool.connect();
    await blocker.query('SELECT pg_advisory_lock_shared(206, 101)');
    const execute = client.db.transaction.bind(client.db);
    let attempts = 0;
    let released = false;
    t.mock.method(client.db, 'transaction', (callback) => execute(async (tx) => {
      const run = tx.execute.bind(tx);
      t.mock.method(tx, 'execute', async (query) => {
        const result = await run(query);
        attempts++;
        if (releaseEarly && !released) {
          released = true;
          await blocker.query('SELECT pg_advisory_unlock_shared(206, 101)');
        }
        return result;
      });
      return callback(tx);
    }));
    try {
      assert.equal(await finalizeMigration(migration.id, true, 'Physical move completed', { contentionAttempts: 3, contentionDelayMs: 10 }), releaseEarly);
      const [row] = await testDb.db.select().from(vmMigrations);
      assert.equal(row.status, releaseEarly ? 'ok' : 'needs_review');
      assert.ok(attempts >= 2);
      assert.equal(client.pool.waitingCount, 0);
      if (releaseEarly) await assertRepointed(source, '2~pve2');
      else {
        assert.equal(row.upstream_status, 'stopped:OK');
        assert.deepEqual((await readPolicies()).leases, [source.lease]);
      }
    } finally {
      if (!released) await blocker.query('SELECT pg_advisory_unlock_shared(206, 101)');
      blocker.release();
    }
  });
}

test('completed migration history does not block a reused VMID at an unrelated location but pending history remains global', async () => {
  const migration = await seedMigration();
  await finalizeMigrationSuccess(client.db, migration.id);
  const replacement = await createLeaseForVm('3~newnode', 101);
  assert.equal(replacement?.node, '3~newnode');
  const sameNameOtherHost = await createLeaseForVm('3~pve2', 101);
  assert.equal(sameNameOtherHost?.node, '3~pve2');
  await assert.rejects(createLeaseForVm('1~pve1', 101), { statusCode: 409 });
  await testDb.db.insert(vmMigrations).values({ vmid: 101, source_node: '4~other', target_node: '5~elsewhere', status: 'needs_review' });
  await assert.rejects(createLeaseForVm('3~newnode', 101), { statusCode: 409 });
});

test('public-IP assignment node/host move atomically while backup task history retains its task host', async (t) => {
  const [firewall] = await testDb.db.insert(firewalls).values({ name: 'test', host: 'firewall.invalid', api_key: 'unused' }).returning();
  const [pool] = await testDb.db.insert(publicIpPools).values({ firewall_id: firewall.id, name: 'test', external_interface: 'wan1' }).returning();
  const [ip] = await testDb.db.insert(publicIps).values({ pool_id: pool.id, firewall_id: firewall.id, address: '192.0.2.20' }).returning();
  const [assignment] = await testDb.db.insert(publicIpAssignments).values({
    public_ip_id: ip.id, firewall_id: firewall.id, user_id: 1, private_ip: '10.0.0.20', node: 'pve1', vmid: 101, proxmox_host_id: 1,
  }).returning();
  const [backup] = await testDb.db.insert(backupTasks).values({ node: '1~pve1', vmid: 101, upid: 'UPID:pve1:backup', status: 'ok' }).returning();
  const migration = await seedMigration();
  const transaction = client.db.transaction.bind(client.db);
  t.mock.method(client.db, 'transaction', (callback) => transaction(async (tx) => {
    const update = tx.update.bind(tx);
    t.mock.method(tx, 'update', (table) => { if (table === publicIpAssignments) throw new Error('IP write failed'); return update(table); });
    return callback(tx);
  }));
  await assert.rejects(finalizeMigrationSuccess(client.db, migration.id), /IP write failed/);
  assert.deepEqual((await testDb.db.select().from(publicIpAssignments))[0], assignment);
  assert.deepEqual((await testDb.db.select().from(backupTasks))[0], backup);
  t.mock.restoreAll();
  assert.equal(await finalizeMigrationSuccess(client.db, migration.id), true);
  assert.deepEqual((await testDb.db.select().from(publicIpAssignments))[0], { ...assignment, node: '2~pve2', proxmox_host_id: 2 });
  assert.deepEqual((await testDb.db.select().from(backupTasks))[0], backup);
});

for (const task of [{ status: 'running' }, { status: 'stopped', exitstatus: 'OK' }]) {
  test(`manual failure rejects upstream ${JSON.stringify(task)} and allows only a later failed result`, async (t) => {
    await seedHost();
    const migration = await seedMigration();
    await testDb.db.update(vmMigrations).set({ status: 'needs_review', upid: 'UPID:pve1:test' }).where(eq(vmMigrations.id, migration.id));
    const original = (await testDb.db.select().from(vmMigrations))[0];
    mockUpstream(t, () => ({ data: task }));
    assert.equal((await request(app).post(`/operations/migration/${migration.id}/resolve`).send({ status: 'error' })).status, 409);
    assert.deepEqual((await testDb.db.select().from(vmMigrations))[0], original);
    t.mock.restoreAll();
    mockUpstream(t, () => ({ data: { status: 'stopped', exitstatus: 'ERROR' } }));
    assert.equal((await request(app).post(`/operations/migration/${migration.id}/resolve`).send({ status: 'error' })).status, 200);
    assert.equal((await testDb.db.select().from(vmMigrations))[0].status, 'error');
  });
}

test('legacy bare source task verification identifies the unique saved task among same-named hosts', async (t) => {
  await seedHost();
  await seedHost(2);
  await testDb.db.update(pveHosts).set({ host: 'host-1.invalid' }).where(eq(pveHosts.id, 1));
  await testDb.db.update(pveHosts).set({ host: 'host-2.invalid' }).where(eq(pveHosts.id, 2));
  const [migration] = await testDb.db.insert(vmMigrations).values({ vmid: 101, source_node: 'pve', target_node: '2~pve', status: 'needs_review', upid: 'UPID:pve:saved' }).returning();
  mockUpstream(t, (url) => url.pathname.endsWith('/nodes') ? { data: [{ node: 'pve' }] }
    : url.hostname === 'host-1.invalid' ? { data: { status: 'stopped', exitstatus: 'OK' } } : { statusCode: 404, data: null });
  assert.equal((await request(app).post(`/operations/migration/${migration.id}/resolve`).send({ status: 'ok' })).status, 200);
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
