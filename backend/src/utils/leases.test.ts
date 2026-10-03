import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { pveHosts, vmLeases, vmMigrations } from '../db/schema/index.ts';
import { sql, eq } from 'drizzle-orm';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let encryptSecret: typeof import('./secrets.ts').encryptSecret;
let runLeaseSweep: typeof import('./leases.ts').runLeaseSweep;
let renewLease: typeof import('./leases.ts').renewLease;
let updateLease: typeof import('./leases.ts').updateLease;
let repointVmRows: typeof import('../routes/migrate.ts').repointVmRows;
let resourceNode = 'pve1';
let visible = true;
let presenceStatus = 404;

let onGetAllVMs: (() => Promise<void>) | null = null;
let onShutdown: (() => Promise<void>) | null = null;
let shutdownCalls: string[] = [];

const origRequest = https.request;
const origDateNow = Date.now;
let timeOffset = 0;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';

  ({ closeDb } = await import('../db/client.ts'));
  ({ encryptSecret } = await import('./secrets.ts'));
  ({ runLeaseSweep, renewLease, updateLease } = await import('./leases.ts'));
  ({ repointVmRows } = await import('../routes/migrate.ts'));

  await testDb.db.insert(pveHosts).values({
    id: 1,
    name: 'pve1',
    host: 'pve.example.com',
    port: 8006,
    token_id: 'root@pam!token',
    token_secret: encryptSecret('test-secret'),
    verify_tls: true,
  });

  Date.now = () => origDateNow() + timeOffset;

  https.request = ((url: URL | string, options: https.RequestOptions, cb?: (res: EventEmitter & { statusCode?: number }) => void) => {
    const targetUrl = typeof url === 'string' ? new URL(url) : url;
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, fn?: () => void) => void;
      destroy: (err?: Error) => void;
      write: (chunk: string | Buffer) => void;
      end: () => void;
    };
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = async () => {
      if (targetUrl.pathname === '/api2/json/cluster/resources') {
        if (onGetAllVMs) await onGetAllVMs();
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = 200;
        if (cb) cb(res);
        res.emit('data', JSON.stringify({
          data: visible ? [{ vmid: 100, node: resourceNode, type: 'qemu', status: 'running' }] : [],
        }));
        res.emit('end');
      } else if (targetUrl.pathname.includes('/status/current')) {
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = presenceStatus;
        if (cb) cb(res);
        res.emit('data', JSON.stringify({ data: presenceStatus === 200 ? { status: 'stopped' } : null }));
        res.emit('end');
      } else if (targetUrl.pathname.includes('/status/shutdown')) {
        shutdownCalls.push(targetUrl.pathname);
        if (onShutdown) await onShutdown();
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = 200;
        if (cb) cb(res);
        res.emit('data', JSON.stringify({ data: 'UPID:pve1:0001:shutdown' }));
        res.emit('end');
      }
    };
    return req as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
});

after(async () => {
  Date.now = origDateNow;
  https.request = origRequest;
  await closeDb?.();
  await testDb.drop();
});

beforeEach(async () => {
  timeOffset += 10000;
  onGetAllVMs = null;
  onShutdown = null;
  shutdownCalls = [];
  resourceNode = 'pve1';
  visible = true;
  presenceStatus = 404;
  await testDb.db.delete(vmLeases);
  await testDb.db.delete(vmMigrations);
});

test('when a lease is renewed during the sweep, the sweep detects the updated expires_at, does not stop the VM, and does not mark it expired', async () => {
  await testDb.db.insert(vmLeases).values({
    node: '1~pve1',
    vmid: 100,
    lease_days: 10,
    expires_at: sql`now() - make_interval(days => 2)`,
    exempt: false,
    expired: false,
  });

  onGetAllVMs = async () => {
    await renewLease('1~pve1', 100);
  };

  const result = await runLeaseSweep();
  assert.equal(result.stopped, 0);
  assert.equal(shutdownCalls.length, 0);

  const [lease] = await testDb.db.select().from(vmLeases).where(eq(vmLeases.vmid, 100));
  assert.equal(lease.expired, false);
  assert.equal(lease.auto_stopped, false);
  assert.ok(lease.expires_at instanceof Date);
  assert.ok(lease.expires_at.getTime() > Date.now());
});

test('when a lease is exempted during the sweep, it does not stop the VM and does not mark it expired', async () => {
  await testDb.db.insert(vmLeases).values({
    node: '1~pve1',
    vmid: 100,
    lease_days: 10,
    expires_at: sql`now() - make_interval(days => 2)`,
    exempt: false,
    expired: false,
  });

  onGetAllVMs = async () => {
    await updateLease('1~pve1', 100, { exempt: true });
  };

  const result = await runLeaseSweep();
  assert.equal(result.stopped, 0);
  assert.equal(shutdownCalls.length, 0);

  const [lease] = await testDb.db.select().from(vmLeases).where(eq(vmLeases.vmid, 100));
  assert.equal(lease.exempt, true);
  assert.equal(lease.expired, false);
  assert.equal(lease.auto_stopped, false);
});

test('when a lease remains expired and un-exempt, it stops the VM and marks expired: true', async () => {
  await testDb.db.insert(vmLeases).values({
    node: '1~pve1',
    vmid: 100,
    lease_days: 10,
    expires_at: sql`now() - make_interval(days => 2)`,
    exempt: false,
    expired: false,
  });

  const result = await runLeaseSweep();
  assert.equal(result.stopped, 1);
  assert.equal(shutdownCalls.length, 1);
  assert.ok(shutdownCalls[0].includes('/nodes/pve1/qemu/100/status/shutdown'));

  const [lease] = await testDb.db.select().from(vmLeases).where(eq(vmLeases.vmid, 100));
  assert.equal(lease.expired, true);
  assert.equal(lease.auto_stopped, true);
  assert.ok(lease.expired_at instanceof Date);
});

test('when a lease is renewed during shutdown execution, the post-shutdown update does not mark it expired', async () => {
  await testDb.db.insert(vmLeases).values({
    node: '1~pve1',
    vmid: 100,
    lease_days: 10,
    expires_at: sql`now() - make_interval(days => 2)`,
    exempt: false,
    expired: false,
  });

  onShutdown = async () => {
    await renewLease('1~pve1', 100);
  };

  await runLeaseSweep();
  assert.equal(shutdownCalls.length, 1);

  const [lease] = await testDb.db.select().from(vmLeases).where(eq(vmLeases.vmid, 100));
  assert.equal(lease.expired, false);
  assert.ok(lease.expires_at instanceof Date);
  assert.ok(lease.expires_at.getTime() > Date.now());
});

async function seedDueLease() {
  await testDb.db.insert(vmLeases).values({
    node: '1~pve1', vmid: 100, lease_days: 10,
    expires_at: sql`now() - make_interval(days => 2)`, exempt: false, expired: false,
  });
}

test('a lease moved while VM enumeration is in flight remains due for the target sweep', async () => {
  await seedDueLease();
  onGetAllVMs = async () => {
    await repointVmRows('1~pve1', 100, '1~pve2');
    resourceNode = 'pve2';
  };
  assert.equal((await runLeaseSweep()).stopped, 0);
  const [moved] = await testDb.db.select().from(vmLeases);
  assert.equal(moved.node, '1~pve2');
  assert.equal(moved.expired, false);
  onGetAllVMs = null;
  assert.equal((await runLeaseSweep()).stopped, 1);
  assert.ok(shutdownCalls[0].includes('/nodes/pve2/qemu/100/status/shutdown'));
});

test('migration repoint rejects an active expiry action and can retry after it completes', async () => {
  await seedDueLease();
  onShutdown = async () => {
    await assert.rejects(repointVmRows('1~pve1', 100, '1~pve2'), { statusCode: 409 });
  };
  assert.equal((await runLeaseSweep()).stopped, 1);
  await repointVmRows('1~pve1', 100, '1~pve2');
  const [lease] = await testDb.db.select().from(vmLeases);
  assert.equal(lease.node, '1~pve2');
  assert.equal(lease.expired, true);
  assert.equal(lease.auto_stopped, true);
});

test('expiry enforcement defers running or reviewable migrations without flagging the lease', async () => {
  await seedDueLease();
  const [migration] = await testDb.db.insert(vmMigrations).values({
    vmid: 100, source_node: '1~pve1', target_node: '2~pve2', status: 'running',
  }).returning();
  for (const status of ['running', 'needs_review']) {
    await testDb.db.update(vmMigrations).set({ status }).where(eq(vmMigrations.id, migration.id));
    assert.equal((await runLeaseSweep()).stopped, 0);
    assert.equal((await testDb.db.select().from(vmLeases))[0].expired, false);
  }
  assert.deepEqual(shutdownCalls, []);
});

test('confirmed absent guests expire without a power action and become reclaimable', async () => {
  await seedDueLease();
  visible = false;
  await runLeaseSweep();
  const [lease] = await testDb.db.select().from(vmLeases);
  assert.equal(lease.expired, true);
  assert.equal(lease.auto_stopped, false);
  assert.ok(lease.expired_at instanceof Date);
  const { computeLeaseView } = await import('./leases.ts');
  assert.equal((await computeLeaseView(lease, 0)).reclaimable, true);
  assert.deepEqual(shutdownCalls, []);
});

for (const status of [503, 200]) {
  test(`missing inventory does not expire a guest with probe status ${status}`, async () => {
    await seedDueLease();
    visible = false;
    presenceStatus = status;
    await runLeaseSweep();
    assert.equal((await testDb.db.select().from(vmLeases))[0].expired, false);
    assert.deepEqual(shutdownCalls, []);
  });
}

test('lease expiry uses the held transaction for host resolution', async (t) => {
  await seedDueLease();
  const { pool } = await import('../db/client.ts');
  const query = pool.query.bind(pool);
  let inventoryRead = false;
  t.mock.method(pool, 'query', (...args: any[]) => {
    const text = args[0]?.text || args[0];
    if (String(text).includes('from "pve_hosts"')) {
      assert.equal(inventoryRead, false, 'shutdown host lookup must use the held lease transaction');
      inventoryRead = true;
    }
    return (query as any)(...args);
  });
  assert.equal((await runLeaseSweep()).stopped, 1);
});
