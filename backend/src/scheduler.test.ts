import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import test, { after, before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { pveHosts, vmSchedules } from './db/schema/index.ts';
import { createTestDatabase, type TestDatabase } from './testUtils/pgTestDb.ts';

let testDb: TestDatabase;
let pool: typeof import('./db/client.ts').pool;
let closeDb: typeof import('./db/client.ts').closeDb;
let runScheduleTick: typeof import('./scheduler.ts').runScheduleTick;
let waitForSchedulerIdle: typeof import('./scheduler.ts').waitForSchedulerIdle;
let startScheduler: typeof import('./scheduler.ts').startScheduler;
let stopScheduler: typeof import('./scheduler.ts').stopScheduler;
let now = Date.parse('2026-10-03T02:00:00Z');
let status = 'running';
let visible = true;
let failAction = false;
let onAction: (() => Promise<void>) | null = null;
let actions: string[] = [];

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';
  ({ pool, closeDb } = await import('./db/client.ts'));
  ({ runScheduleTick, waitForSchedulerIdle, startScheduler, stopScheduler } = await import('./scheduler.ts'));
  const { encryptSecret } = await import('./utils/secrets.ts');
  await testDb.db.insert(pveHosts).values({
    id: 1,
    name: 'scheduler-test',
    host: 'pve.invalid',
    token_id: 'root@pam!test',
    token_secret: encryptSecret('test-secret'),
    verify_tls: true,
  });
});

after(async () => {
  await closeDb();
  await testDb.drop();
});

beforeEach(async (t) => {
  now = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000 + 2 * 3_600_000;
  status = 'running';
  visible = true;
  failAction = false;
  onAction = null;
  actions = [];
  await testDb.db.delete(vmSchedules);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.setTimeout = () => {};
    req.destroy = (err: Error) => req.emit('error', err);
    req.write = () => {};
    req.end = () => {
      void (async () => {
        let data: any;
        let statusCode = 200;
        if (url.pathname === '/api2/json/cluster/resources') {
          data = visible ? [{ vmid: 100, node: 'pve1', type: 'qemu', status }] : [];
        } else if (options.method === 'POST') {
          const action = url.pathname.split('/').at(-1)!;
          actions.push(action);
          if (onAction) await onAction();
          if (failAction) {
            statusCode = 500;
            data = 'action failed';
          } else {
            status = action === 'start' ? 'running' : 'stopped';
            data = 'UPID:pve1:test';
          }
        } else if (url.pathname.endsWith('/status/current')) {
          data = { status };
        } else {
          throw new Error(`Unexpected Proxmox request: ${options.method} ${url.pathname}`);
        }
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;
        callback(res);
        res.emit('data', JSON.stringify({ data }));
        res.emit('end');
      })().catch((err) => req.emit('error', err));
    };
    return req;
  });
});

async function insertSchedule(overrides: Partial<typeof vmSchedules.$inferInsert> = {}) {
  const [schedule] = await testDb.db.insert(vmSchedules).values({
    node: '1~pve1',
    vmid: 100,
    enabled: true,
    stop_time: '01:00',
    start_time: '08:00',
    days: 127,
    timezone: 'UTC',
    ...overrides,
  }).returning();
  return schedule;
}

async function readSchedule() {
  const [schedule] = await testDb.db.select().from(vmSchedules);
  return schedule;
}

async function sweep() {
  await runScheduleTick();
  assert.equal(await waitForSchedulerIdle(), true);
}

function afterSnapshot(t: any, change: () => Promise<void>) {
  const query = pool.query.bind(pool);
  let pending = true;
  t.mock.method(pool, 'query', async (...args: any[]) => {
    const result = await (query as any)(...args);
    const text = args[0]?.text || args[0];
    if (pending && typeof text === 'string' && text.startsWith('select "id", "node", "vmid"') && text.includes('from "vm_schedules"')) {
      pending = false;
      await change();
    }
    return result;
  });
  return () => assert.equal(pending, false, 'the edit must occur after the enabled schedule snapshot');
}

function interceptGuardQuery(t: any, intercept: (query: () => Promise<any>, args: any[]) => Promise<any>) {
  const connect = pool.connect.bind(pool);
  const patched = new WeakSet();
  t.mock.method(pool, 'connect', (...args: any[]) => {
    if (args.length) return (connect as any)(...args);
    return connect().then((connection) => {
      if (!patched.has(connection)) {
        patched.add(connection);
        const query = connection.query.bind(connection);
        t.mock.method(connection, 'query', (...queryArgs: any[]) => intercept(() => (query as any)(...queryArgs), queryArgs));
      }
      return connection;
    });
  });
}

const changes: [string, Partial<typeof vmSchedules.$inferInsert>][] = [
  ['disabled', { enabled: false }],
  ['stop time edited', { stop_time: '04:00' }],
  ['start time edited', { start_time: '01:30' }],
  ['days edited', { days: 2 }],
  ['timezone edited', { timezone: 'America/New_York' }],
  ['skip requested', { skip_until: Date.parse('2027-10-04T00:00:00Z') }],
  ['node edited', { node: '1~pve2' }],
  ['VMID edited', { vmid: 101 }],
  ['window state edited', { last_off: -1 }],
  ['manual override set', { running_due_to_manual: true }],
  ['stop completion recorded', { stopped_this_window: true }],
  ['updated with unchanged decision fields', { updated_at: new Date('2026-10-01T00:00:00Z') }],
];

for (const action of ['stop', 'start'] as const) {
  for (const [name, update] of changes) {
    test(`does not ${action} when the schedule is ${name} after the snapshot`, async (t) => {
      status = action === 'stop' ? 'running' : 'stopped';
      const original = await insertSchedule({ last_off: 1, ...(action === 'start' ? { stop_time: '03:00' } : {}) });
      const assertEdited = afterSnapshot(t, async () => {
        await testDb.db.update(vmSchedules).set(update).where(eq(vmSchedules.id, original.id));
      });
      await sweep();
      assertEdited();
      assert.deepEqual(actions, []);
      const current = await readSchedule();
      assert.deepEqual(current, { ...original, ...update });
    });
  }

  test(`does not ${action} when the schedule is deleted after the snapshot`, async (t) => {
    status = action === 'stop' ? 'running' : 'stopped';
    await insertSchedule({ last_off: 1, ...(action === 'start' ? { stop_time: '03:00' } : {}) });
    const assertEdited = afterSnapshot(t, async () => { await testDb.db.delete(vmSchedules); });
    await sweep();
    assertEdited();
    assert.deepEqual(actions, []);
    assert.equal(await readSchedule(), undefined);
  });
}

for (const action of ['stop', 'start'] as const) {
  for (const [name, update] of changes) {
    test(`CAS rejects ${action} when the schedule is ${name} after migration guard validation`, async (t) => {
      status = action === 'stop' ? 'running' : 'stopped';
      const original = await insertSchedule({ last_off: 1, ...(action === 'start' ? { stop_time: '03:00' } : {}) });
      let edited = false;
      let rowCount: number | undefined;
      interceptGuardQuery(t, async (query, args) => {
        if (!edited && args[0]?.text?.startsWith('update "vm_schedules"')) {
          edited = true;
          await testDb.db.update(vmSchedules).set(update).where(eq(vmSchedules.id, original.id));
          const result = await query();
          rowCount = result.rowCount;
          return result;
        }
        return query();
      });
      await sweep();
      assert.equal(edited, true);
      assert.equal(rowCount, 0);
      assert.deepEqual(actions, []);
      assert.deepEqual(await readSchedule(), { ...original, ...update });
    });
  }
}

test('a failed database claim never dispatches a power action', async (t) => {
  const original = await insertSchedule();
  interceptGuardQuery(t, async (query, args) => {
    if (args[0]?.text?.startsWith('update "vm_schedules"')) {
      throw new Error('claim unavailable');
    }
    return query();
  });
  const warnings = t.mock.method(console, 'warn', () => {});
  await sweep();
  assert.equal(warnings.mock.callCount(), 1);
  assert.deepEqual(actions, []);
  assert.deepEqual(await readSchedule(), original);
});

test('claims flags before dispatch, records a successful stop and respects a later manual start', async () => {
  await insertSchedule();
  onAction = async () => {
    const current = await readSchedule();
    assert.equal(current.last_off, 1);
    assert.equal(current.stopped_this_window, false);
  };
  await sweep();
  assert.deepEqual(actions, ['shutdown']);
  let current = await readSchedule();
  assert.equal(current.stopped_this_window, true);
  assert.equal(current.last_action, 'stop:shutdown');
  assert.equal(current.last_action_at, now);

  status = 'running';
  now += 10_000;
  await sweep();
  current = await readSchedule();
  assert.equal(current.running_due_to_manual, true);
  assert.deepEqual(actions, ['shutdown']);
});

test('claims the leaving edge before dispatch and starts only once', async () => {
  status = 'stopped';
  await insertSchedule({ stop_time: '03:00', last_off: 1, stopped_this_window: true, running_due_to_manual: true });
  onAction = async () => {
    const current = await readSchedule();
    assert.equal(current.last_off, 0);
    assert.equal(current.running_due_to_manual, false);
    assert.equal(current.stopped_this_window, false);
  };
  await sweep();
  const current = await readSchedule();
  assert.equal(current.last_action, 'start:start');
  assert.equal(current.last_action_at, now);
  status = 'stopped';
  now += 10_000;
  await sweep();
  assert.deepEqual(actions, ['start']);
});

test('failed stop keeps the claimed window unsatisfied and retries next tick', async () => {
  await insertSchedule();
  failAction = true;
  await sweep();
  let current = await readSchedule();
  assert.equal(current.last_off, 1);
  assert.equal(current.stopped_this_window, false);
  assert.equal(current.running_due_to_manual, false);
  assert.equal(current.last_action, 'stop_failed');
  assert.equal(current.last_action_at, now);
  assert.deepEqual(actions, ['shutdown', 'stop']);

  failAction = false;
  now += 10_000;
  await sweep();
  current = await readSchedule();
  assert.equal(current.stopped_this_window, true);
  assert.equal(current.last_action, 'stop:shutdown');
  assert.deepEqual(actions, ['shutdown', 'stop', 'shutdown']);
});

test('failed start consumes the leaving edge and is not retried outside the off-window', async () => {
  status = 'stopped';
  await insertSchedule({ stop_time: '03:00', last_off: 1 });
  failAction = true;
  await sweep();
  const current = await readSchedule();
  assert.equal(current.last_off, 0);
  assert.equal(current.last_action, 'start_failed');
  assert.equal(current.last_action_at, now);

  failAction = false;
  now += 10_000;
  await sweep();
  assert.deepEqual(actions, ['start']);
});

for (const action of ['stop', 'start'] as const) {
  for (const fail of [false, true]) {
    test(`${fail ? 'failed' : 'successful'} in-flight ${action} does not overwrite a redefined schedule`, async () => {
      status = action === 'stop' ? 'running' : 'stopped';
      const original = await insertSchedule(action === 'start' ? { stop_time: '03:00', last_off: 1 } : {});
      let edited: typeof original;
      failAction = fail;
      onAction = async () => {
        const [current] = await testDb.db.update(vmSchedules).set({
          stop_time: '04:00',
          last_off: -1,
          running_due_to_manual: false,
          stopped_this_window: false,
          updated_at: new Date(now),
        }).where(eq(vmSchedules.id, original.id)).returning();
        edited = current;
      };
      await sweep();
      assert.deepEqual(await readSchedule(), edited!);
      assert.deepEqual(actions, action === 'start' ? ['start'] : fail ? ['shutdown', 'stop'] : ['shutdown']);
    });
  }
}

test('a later tick cannot consume a start edge while its claim is pending', { timeout: 5_000 }, async (t) => {
  status = 'stopped';
  const original = await insertSchedule({ stop_time: '03:00', last_off: 1 });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let intercepted = false;
  interceptGuardQuery(t, async (query, args) => {
    if (!intercepted && args[0]?.text?.startsWith('update "vm_schedules"')) {
      intercepted = true;
      entered.resolve();
      await release.promise;
    }
    return query();
  });
  try {
    await runScheduleTick();
    await entered.promise;
    now += 10_000;
    await runScheduleTick();
    assert.deepEqual(await readSchedule(), original);
    assert.deepEqual(actions, []);
  } finally {
    release.resolve();
    assert.equal(await waitForSchedulerIdle(), true);
  }
  assert.deepEqual(actions, ['start']);
  assert.equal((await readSchedule()).last_action, 'start:start');
});

test('a slow stop does not stall ticks or dispatch a duplicate stop', async () => {
  await insertSchedule();
  let release!: () => void;
  let started!: () => void;
  const actionStarted = new Promise<void>((resolve) => { started = resolve; });
  const actionReleased = new Promise<void>((resolve) => { release = resolve; });
  onAction = async () => {
    started();
    await actionReleased;
  };
  try {
    await runScheduleTick();
    await actionStarted;
    assert.deepEqual(actions, ['shutdown']);
    now += 10_000;
    await runScheduleTick();
    assert.deepEqual(actions, ['shutdown']);
    assert.equal((await readSchedule()).stopped_this_window, false);
  } finally {
    release();
    assert.equal(await waitForSchedulerIdle(), true);
  }
  assert.equal((await readSchedule()).stopped_this_window, true);
});

test('a slow stop completing after the leaving edge records its outcome without satisfying the old window', async () => {
  await insertSchedule();
  let release!: () => void;
  let started!: () => void;
  const actionStarted = new Promise<void>((resolve) => { started = resolve; });
  const actionReleased = new Promise<void>((resolve) => { release = resolve; });
  onAction = async () => {
    started();
    await actionReleased;
  };
  try {
    await runScheduleTick();
    await actionStarted;
    now = Math.floor(now / 86_400_000) * 86_400_000 + 8 * 3_600_000;
    await runScheduleTick();
    assert.equal((await readSchedule()).last_off, 0);
  } finally {
    release();
    assert.equal(await waitForSchedulerIdle(), true);
  }
  const current = await readSchedule();
  assert.equal(current.stopped_this_window, false);
  assert.equal(current.last_action, 'stop:shutdown');
  assert.equal(current.last_action_at, now);
  assert.deepEqual(actions, ['shutdown']);
});

test('skip suppresses both edges without deferring the start into daytime', async () => {
  await insertSchedule({ skip_until: now + 60_000 });
  await sweep();
  assert.deepEqual(actions, []);
  assert.equal((await readSchedule()).last_off, 1);

  status = 'stopped';
  await testDb.db.update(vmSchedules).set({ stop_time: '03:00' });
  now += 10_000;
  await sweep();
  assert.equal((await readSchedule()).last_off, 0);
  now += 60_000;
  await sweep();
  assert.deepEqual(actions, []);
});

test('an already stopped VM satisfies the window without a power action', async () => {
  status = 'stopped';
  await insertSchedule();
  await sweep();
  assert.equal((await readSchedule()).stopped_this_window, true);
  status = 'running';
  now += 10_000;
  await sweep();
  assert.equal((await readSchedule()).running_due_to_manual, true);
  assert.deepEqual(actions, []);
});

test('an invisible VM freezes the window edge', async () => {
  visible = false;
  const original = await insertSchedule({ last_off: 1, stop_time: '03:00' });
  await sweep();
  assert.deepEqual(await readSchedule(), original);
  assert.deepEqual(actions, []);
});

for (const action of ['stop', 'start'] as const) {
  test(`shutdown after the ${action} claim still dispatches and drains the claimed action`, { timeout: 5_000 }, async (t) => {
    status = action === 'stop' ? 'running' : 'stopped';
    await insertSchedule(action === 'start' ? { stop_time: '03:00', last_off: 1 } : {});
    let stoppedAtClaim = false;
    interceptGuardQuery(t, async (query, args) => {
      const result = await query();
      if (!stoppedAtClaim && args[0]?.text?.startsWith('update "vm_schedules"')) {
        assert.equal(result.rowCount, 1);
        stoppedAtClaim = true;
        stopScheduler();
      }
      return result;
    });
    let release!: () => void;
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => { started = resolve; });
    const actionReleased = new Promise<void>((resolve) => { release = resolve; });
    onAction = async () => {
      started();
      await actionReleased;
    };
    t.mock.method(console, 'log', () => {});
    startScheduler();
    try {
      await runScheduleTick();
      await actionStarted;
      assert.equal(stoppedAtClaim, true);
      assert.equal(await waitForSchedulerIdle(0), false);
      assert.deepEqual(actions, [action === 'start' ? 'start' : 'shutdown']);
      const claimed = await readSchedule();
      assert.equal(claimed.last_off, action === 'start' ? 0 : 1);
      assert.equal(claimed.last_action, '');
      now += 10_000;
      await runScheduleTick();
      assert.deepEqual(await readSchedule(), claimed);
      assert.deepEqual(actions, [action === 'start' ? 'start' : 'shutdown']);
    } finally {
      stopScheduler();
      release();
      assert.equal(await waitForSchedulerIdle(), true);
    }
    const current = await readSchedule();
    assert.equal(current.last_action, action === 'start' ? 'start:start' : 'stop:shutdown');
    assert.equal(current.last_action_at, now);
    assert.equal(current.stopped_this_window, action === 'stop');
  });
}

test('shutdown during migration guard validation leaves the start edge unconsumed', { timeout: 5_000 }, async (t) => {
  status = 'stopped';
  const original = await insertSchedule({ stop_time: '03:00', last_off: 1 });
  let stopped = false;
  interceptGuardQuery(t, async (query, args) => {
    const result = await query();
    if (!stopped && args[0]?.text?.startsWith('select "id", "node", "vmid"') && args[0].text.includes('from "vm_schedules"')) {
      stopped = true;
      stopScheduler();
    }
    return result;
  });
  t.mock.method(console, 'log', () => {});
  startScheduler();
  try {
    await sweep();
    assert.equal(stopped, true);
    assert.deepEqual(actions, []);
    assert.deepEqual(await readSchedule(), original);
  } finally {
    stopScheduler();
    assert.equal(await waitForSchedulerIdle(), true);
  }
});

test('shutdown before the claim leaves the start edge unconsumed', async (t) => {
  status = 'stopped';
  const original = await insertSchedule({ stop_time: '03:00', last_off: 1 });
  const assertStopped = afterSnapshot(t, async () => { stopScheduler(); });
  t.mock.method(console, 'log', () => {});
  startScheduler();
  try {
    await sweep();
    assertStopped();
    assert.deepEqual(actions, []);
    assert.deepEqual(await readSchedule(), original);
  } finally {
    stopScheduler();
    assert.equal(await waitForSchedulerIdle(), true);
  }
});
