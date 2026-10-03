import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './testUtils/pgTestDb.ts';
import { pveHosts, vmMigrations, vmSchedules } from './db/schema/index.ts';

let testDb: TestDatabase;
let client: typeof import('./db/client.ts');
let scheduler: typeof import('./scheduler.ts');
let repointVmRows: typeof import('./routes/migrate.ts').repointVmRows;
let actions: string[];
let status: string;
let onAction: (() => Promise<void>) | null;
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
      if (url.pathname === '/api2/json/cluster/resources') data = [{ vmid: 100, node: 'pve1', type: 'qemu', status }];
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

async function blocked() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await testDb.pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'");
    if (rows[0].count > 0) return;
    await delay(10);
  }
  assert.fail('scheduler/migration did not wait for the shared VM lock');
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

  test(`migration registration waits for an already dispatched scheduled ${action}`, async () => {
    await seed(action);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onAction = async () => { entered.resolve(); await release.promise; };
    await scheduler.runScheduleTick();
    await entered.promise;
    const migration = testDb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(206, 100)`);
      await tx.insert(vmMigrations).values({ vmid: 100, source_node: '1~pve1', target_node: '2~pve2' });
    });
    try {
      await blocked();
      assert.deepEqual(await testDb.db.select().from(vmMigrations), []);
    } finally {
      release.resolve();
    }
    await migration;
    assert.equal(await scheduler.waitForSchedulerIdle(), true);
    assert.equal(actions.length, 1);
  });
}
