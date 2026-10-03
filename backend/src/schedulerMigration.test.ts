import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './testUtils/pgTestDb.ts';
import { pveHosts, vmMigrations, vmSchedules } from './db/schema/index.ts';

let testDb: TestDatabase;
let client: typeof import('./db/client.ts');
let scheduler: typeof import('./scheduler.ts');
let repointVmRows: typeof import('./routes/migrate.ts').repointVmRows;
let actions: string[];
let status: string;
let onAction: (() => Promise<void>) | null;
let vmids = [100];
let now = Date.parse('2026-10-03T02:00:00Z');

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '44'.repeat(32);
  client = await import('./db/client.ts');
  scheduler = await import('./scheduler.ts');
  ({ repointVmRows } = await import('./routes/migrate.ts'));
  const { encryptSecret } = await import('./utils/secrets.ts');
  await testDb.db.insert(pveHosts).values({ id: 1, name: 'source', host: 'source.invalid', token_id: 'test', token_secret: encryptSecret('test'), verify_tls: true });
});

after(async () => {
  await client.closeDb();
  await testDb.drop();
});

beforeEach(async (t) => {
  now += 86_400_000;
  actions = [];
  status = 'running';
  onAction = null;
  vmids = [100];
  await testDb.db.delete(vmSchedules);
  await testDb.db.delete(vmMigrations);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter() as any;
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (err) => req.emit('error', err);
    req.end = async () => {
      let data;
      if (url.pathname === '/api2/json/cluster/resources') data = vmids.map((vmid) => ({ vmid, node: 'pve1', type: 'qemu', status }));
      else if (options.method === 'POST') {
        actions.push(url.pathname);
        if (onAction) await onAction();
        status = url.pathname.endsWith('/start') ? 'running' : 'stopped';
        data = 'UPID:pve1:test';
      } else data = { status };
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      callback(res);
      res.emit('data', JSON.stringify({ data }));
      res.emit('end');
    };
    return req;
  });
});

async function seed(action: 'stop' | 'start') {
  status = action === 'stop' ? 'running' : 'stopped';
  const [row] = await testDb.db.insert(vmSchedules).values({
    node: '1~pve1', vmid: 100, enabled: true, stop_time: action === 'stop' ? '01:00' : '03:00',
    start_time: '08:00', days: 127, timezone: 'UTC', last_off: 1,
  }).returning();
  return row;
}

async function assertNoAdvisoryWaiters() {
  const { rows } = await testDb.pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'");
  assert.equal(rows[0].count, 0);
  assert.equal(client.pool.waitingCount, 0);
}

for (const action of ['stop', 'start'] as const) {
  test(`scheduler defers ${action} during a pending migration without consuming its edge`, async () => {
    const original = await seed(action);
    await testDb.db.insert(vmMigrations).values({ vmid: 100, source_node: '1~pve1', target_node: '2~pve2', status: 'running' });
    await scheduler.runScheduleTick();
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.deepEqual(actions, []);
    assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], original);
  });

  test(`scheduler defers ${action} during migration review without consuming its edge`, async () => {
    const original = await seed(action);
    await testDb.db.insert(vmMigrations).values({ vmid: 100, source_node: '1~pve1', target_node: '2~pve2', status: 'needs_review' });
    await scheduler.runScheduleTick();
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.deepEqual(actions, []);
    assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], original);
  });

  test(`scheduler dispatches ${action} at the completed migration's current target`, async () => {
    await seed(action);
    await testDb.db.insert(vmMigrations).values({ vmid: 100, source_node: '2~pve2', target_node: '1~pve1', status: 'ok' });
    await scheduler.runScheduleTick();
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.equal(actions.length, 1);
    assert.equal((await testDb.db.select().from(vmSchedules))[0].last_action, action === 'start' ? 'start:start' : 'stop:shutdown');
  });

  test(`scheduler selected before repoint cannot dispatch ${action} to the stale source`, async (t) => {
    const original = await seed(action);
    const query = client.pool.query.bind(client.pool);
    let moved = false;
    t.mock.method(client.pool, 'query', async (...args: any[]) => {
      const result = await (query as any)(...args);
      if (!moved && args[0]?.text?.startsWith('select "id", "node", "vmid"') && args[0].text.includes('from "vm_schedules"')) {
        moved = true;
        await repointVmRows('1~pve1', 100, '1~pve2');
      }
      return result;
    });
    await scheduler.runScheduleTick();
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.equal(moved, true);
    assert.deepEqual(actions, []);
    assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], { ...original, node: '1~pve2' });
  });

  test(`scheduler does not ${action} or consume flags at a completed migration's stale source`, async () => {
    const original = await seed(action);
    await testDb.db.insert(vmMigrations).values({ vmid: 100, source_node: '1~pve1', target_node: '2~pve2', status: 'ok' });
    await scheduler.runScheduleTick();
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.deepEqual(actions, []);
    assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], original);
  });

  test(`migration holding the logical VM lock repoints before the selected ${action} can claim`, async () => {
    const original = await seed(action);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const migration = testDb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(206, 100)`);
      held.resolve();
      await release.promise;
      await tx.update(vmSchedules).set({ node: '2~pve2' }).where(eq(vmSchedules.id, original.id));
      await tx.insert(vmMigrations).values({ vmid: 100, source_node: '1~pve1', target_node: '2~pve2', status: 'ok' });
    });
    await held.promise;
    try {
      await scheduler.runScheduleTick();
      assert.equal(await scheduler.waitForSchedulerIdle(), true);
      await assertNoAdvisoryWaiters();
      assert.deepEqual(actions, []);
      assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], original);
    } finally {
      release.resolve();
      await migration;
    }
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.deepEqual(actions, []);
    assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], { ...original, node: '2~pve2' });
  });

  test(`migration registration fails fast during a dispatched scheduled ${action} and succeeds after completion`, async () => {
    await seed(action);
    const { lockVmMigration } = await import('./utils/vmMigrationLock.ts');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onAction = async () => { entered.resolve(); await release.promise; };
    await scheduler.runScheduleTick();
    await entered.promise;
    const register = () => testDb.db.transaction(async (tx) => {
      await lockVmMigration(tx, 100);
      await tx.insert(vmMigrations).values({ vmid: 100, source_node: '1~pve1', target_node: '2~pve2' });
    });
    try {
      await assert.rejects(register(), { statusCode: 409 });
      await assertNoAdvisoryWaiters();
      assert.deepEqual(await testDb.db.select().from(vmMigrations), []);
    } finally {
      release.resolve();
      assert.equal(await scheduler.waitForSchedulerIdle(), true);
    }
    await register();
    assert.equal((await testDb.db.select().from(vmMigrations)).length, 1);
    assert.equal(actions.length, 1);
  });

  test(`migration cannot repoint between the successful ${action} CAS and dispatch`, { timeout: 5_000 }, async (t) => {
    const original = await seed(action);
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const connect = client.pool.connect.bind(client.pool);
    const patched = new WeakSet();
    let intercepted = false;
    t.mock.method(client.pool, 'connect', (...args: any[]) => {
      if (args.length) return (connect as any)(...args);
      return connect().then((connection) => {
        if (!patched.has(connection)) {
          patched.add(connection);
          const query = connection.query.bind(connection);
          t.mock.method(connection, 'query', async (...queryArgs: any[]) => {
            const result = await (query as any)(...queryArgs);
            if (!intercepted && queryArgs[0]?.text?.startsWith('update "vm_schedules"')) {
              assert.equal(result.rowCount, 1);
              intercepted = true;
              claimed.resolve();
              await release.promise;
            }
            return result;
          });
        }
        return connection;
      });
    });
    await scheduler.runScheduleTick();
    await claimed.promise;
    try {
      await assert.rejects(repointVmRows('1~pve1', 100, '2~pve2'), { statusCode: 409 });
      await assertNoAdvisoryWaiters();
      assert.deepEqual(actions, []);
      const [current] = await testDb.db.select().from(vmSchedules);
      assert.equal(current.node, original.node);
      assert.equal(current.last_off, action === 'start' ? 0 : 1);
    } finally {
      release.resolve();
      assert.equal(await scheduler.waitForSchedulerIdle(), true);
    }
    await repointVmRows('1~pve1', 100, '2~pve2');
    const [moved] = await testDb.db.select().from(vmSchedules);
    assert.equal(moved.node, '2~pve2');
    assert.equal(moved.last_action, action === 'start' ? 'start:start' : 'stop:shutdown');
    assert.equal(actions.length, 1);
  });

  test(`migration repoint is rejected throughout the ${action} claim and completion bookkeeping`, async () => {
    const original = await seed(action);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onAction = async () => { entered.resolve(); await release.promise; };
    await scheduler.runScheduleTick();
    await entered.promise;
    const [claimed] = await testDb.db.select().from(vmSchedules);
    assert.equal(claimed.last_off, action === 'start' ? 0 : 1);
    assert.equal(claimed.last_action, '');
    try {
      await assert.rejects(repointVmRows('1~pve1', 100, '2~pve2'), { statusCode: 409 });
      await assertNoAdvisoryWaiters();
      assert.equal((await testDb.db.select().from(vmSchedules))[0].node, original.node);
    } finally {
      release.resolve();
      assert.equal(await scheduler.waitForSchedulerIdle(), true);
    }
    await repointVmRows('1~pve1', 100, '2~pve2');
    const [moved] = await testDb.db.select().from(vmSchedules);
    assert.equal(moved.node, '2~pve2');
    assert.equal(moved.id, original.id);
    assert.equal(moved.last_action, action === 'start' ? 'start:start' : 'stop:shutdown');
    assert.equal(moved.last_action_at, now);
    assert.equal(moved.stopped_this_window, action === 'stop');
    assert.equal(actions.length, 1);
  });
}

for (const action of ['stop', 'start'] as const) {
  test(`cross-process lock rejection preserves the ${action} edge until a successful retry`, { timeout: 5_000 }, async (t) => {
    const original = await seed(action);
    const blocker = await testDb.pool.connect();
    await blocker.query('SELECT pg_advisory_lock(206, 100)');
    t.mock.method(console, 'warn', () => {});
    try {
      await scheduler.runScheduleTick();
      assert.equal(await scheduler.waitForSchedulerIdle(), true);
      assert.deepEqual(actions, []);
      assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], original);
      await assertNoAdvisoryWaiters();
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(206, 100)');
      blocker.release();
    }
    now += 10_000;
    await scheduler.runScheduleTick();
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.equal(actions.length, 1);
    assert.equal((await testDb.db.select().from(vmSchedules))[0].last_action, action === 'start' ? 'start:start' : 'stop:shutdown');
  });

  test(`pre-checkout admission rejection preserves the ${action} edge and spare pool capacity`, { timeout: 5_000 }, async (t) => {
    const original = await seed(action);
    const { withVmMigrationLock } = await import('./utils/vmMigrationLock.ts');
    const originalMax = client.pool.options.max;
    client.pool.options.max = 2;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withVmMigrationLock(999, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const connect = client.pool.connect.bind(client.pool);
    let guardCheckouts = 0;
    t.mock.method(client.pool, 'connect', (...args: any[]) => {
      if (!args.length) guardCheckouts++;
      return (connect as any)(...args);
    });
    t.mock.method(console, 'warn', () => {});
    try {
      await scheduler.runScheduleTick();
      assert.equal(await scheduler.waitForSchedulerIdle(), true);
      assert.equal(guardCheckouts, 0);
      assert.deepEqual(actions, []);
      assert.deepEqual((await testDb.db.select().from(vmSchedules))[0], original);
      await client.db.select().from(vmSchedules);
      await assertNoAdvisoryWaiters();
    } finally {
      release.resolve();
      await holder;
      client.pool.options.max = originalMax;
    }
    now += 10_000;
    await scheduler.runScheduleTick();
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.equal(actions.length, 1);
  });
}

test('qualified schedules use target inventory even when a retained same-named source appears first', () => {
  const inventory = [
    { vmid: 100, node: 'pve', nodeRef: '1~pve', status: 'stopped' },
    { vmid: 100, node: 'pve', nodeRef: '2~pve', status: 'running' },
  ];
  assert.equal(scheduler.findVmStatus(inventory, '2~pve', 100), 'running');
  assert.equal(scheduler.findVmStatus(inventory.slice(0, 1), '2~pve', 100), null);
  assert.equal(scheduler.findVmStatus(inventory, 'pve', 100), 'stopped');
});

test('contending lock requests fail before checkout and leave unrelated pool work usable', async (t) => {
  const { withVmMigrationLock, withVmPolicyWrite } = await import('./utils/vmMigrationLock.ts');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = withVmMigrationLock(100, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const connect = t.mock.method(client.pool, 'connect', client.pool.connect.bind(client.pool));
  try {
    const requests = Array.from({ length: 30 }, (_, index) => index % 2
      ? withVmMigrationLock(100, async () => {}) : withVmPolicyWrite('1~pve1', 100, async () => {}));
    const results = await Promise.allSettled(requests);
    assert.ok(results.every((result) => result.status === 'rejected' && result.reason.statusCode === 409));
    assert.equal(connect.mock.callCount(), 0);
    await client.db.select().from(vmSchedules);
  } finally { release.resolve(); }
  await holder;
});

test('cross-process advisory contention is rejected without leaving a checked-out waiter', async () => {
  const { withVmMigrationLock } = await import('./utils/vmMigrationLock.ts');
  const blocker = await testDb.pool.connect();
  await blocker.query('SELECT pg_advisory_lock(206, 100)');
  try {
    for (let i = 0; i < 20; i++) await assert.rejects(withVmMigrationLock(100, async () => {}), { statusCode: 409 });
    assert.equal(client.pool.waitingCount, 0);
    const { rows } = await testDb.pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'");
    assert.equal(rows[0].count, 0);
    await client.db.select().from(vmSchedules);
  } finally {
    await blocker.query('SELECT pg_advisory_unlock(206, 100)');
    blocker.release();
  }
});

test('invalid or single-client pools are rejected before any action can hold a migration lock', async () => {
  const run = promisify(execFile);
  for (const size of ['1', '0', '-1', '1.5', 'NaN']) {
    await assert.rejects(run(process.execPath, ['--input-type=module', '-e', "await import('./src/db/client.ts')"], {
      env: { ...process.env, PG_POOL_SIZE: size, DATABASE_URL: testDb.url }, timeout: 5000,
    }), (err: any) => /PG_POOL_SIZE must be an integer of at least 2/.test(err.stderr));
  }
});

for (const action of ['stop', 'start'] as const) {
  test(`two-client scheduler reserves capacity and uses the held host lookup for ${action}`, { timeout: 5_000 }, async (t) => {
    const originalMax = client.pool.options.max;
    client.pool.options.max = 2;
    vmids = [100, 101];
    const original = await seed(action);
    const [deferred] = await testDb.db.insert(vmSchedules).values({ ...original, id: undefined, vmid: 101 }).returning();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onAction = async () => { entered.resolve(); await release.promise; };
    const query = client.pool.query.bind(client.pool);
    let inventoryRead = false;
    t.mock.method(client.pool, 'query', (...args: any[]) => {
      const text = args[0]?.text || args[0];
      if (String(text).includes('from "pve_hosts"')) {
        assert.equal(inventoryRead, false, 'scheduler host lookup must use the held connection');
        inventoryRead = true;
      }
      return (query as any)(...args);
    });
    try {
      await scheduler.runScheduleTick();
      await entered.promise;
      assert.equal(actions.length, 1);
      const schedules = await client.db.select().from(vmSchedules);
      assert.equal(schedules.length, 2);
      assert.deepEqual(schedules.find((schedule) => schedule.vmid === 101), deferred);
      await assertNoAdvisoryWaiters();
    } finally {
      release.resolve();
      assert.equal(await scheduler.waitForSchedulerIdle(), true);
      client.pool.options.max = originalMax;
    }
  });
}

for (const shared of [false, true]) {
  test(`failed ${shared ? 'shared' : 'exclusive'} lock callback releases admission and the PostgreSQL lock`, async () => {
    const { withVmMigrationLock } = await import('./utils/vmMigrationLock.ts');
    await assert.rejects(withVmMigrationLock(100, async () => { throw new Error('callback failed'); }, shared), /callback failed/);
    await testDb.db.transaction(async (tx) => {
      const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(206, 100) AS locked`);
      assert.equal(result.rows[0].locked, true);
    });
    await withVmMigrationLock(100, async () => {});
  });

  test(`failed ${shared ? 'shared' : 'exclusive'} unlock destroys the held connection and releases admission`, async (t) => {
    const { withVmMigrationLock } = await import('./utils/vmMigrationLock.ts');
    const connect = client.pool.connect.bind(client.pool);
    let releasedWithError = false;
    let pid: number | undefined;
    let patched = false;
    t.mock.method(client.pool, 'connect', (...args: any[]) => {
      if (args.length) return (connect as any)(...args);
      return connect().then((connection) => {
        if (!patched) {
          patched = true;
          const query = connection.query.bind(connection);
          const release = connection.release.bind(connection);
          t.mock.method(connection, 'query', (...queryArgs: any[]) => {
            if (String(queryArgs[0]).startsWith('SELECT pg_advisory_unlock')) throw new Error('unlock failed');
            return (query as any)(...queryArgs);
          });
          t.mock.method(connection, 'release', (err?: Error) => {
            releasedWithError = err?.message === 'unlock failed';
            release(err);
          });
        }
        return connection;
      });
    });
    await withVmMigrationLock(100, async (database) => {
      const result = await database.execute(sql`SELECT pg_backend_pid() AS pid`);
      pid = result.rows[0].pid;
    }, shared);
    assert.equal(releasedWithError, true);
    await withVmMigrationLock(100, async (database) => {
      const result = await database.execute(sql`SELECT pg_backend_pid() AS pid`);
      assert.notEqual(result.rows[0].pid, pid);
    });
    await assertNoAdvisoryWaiters();
  });
}
