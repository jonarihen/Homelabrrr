import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { pveHosts, vmLeases } from '../db/schema/index.ts';
import { sql, eq } from 'drizzle-orm';

let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;
let encryptSecret: typeof import('./secrets.ts').encryptSecret;
let runLeaseSweep: typeof import('./leases.ts').runLeaseSweep;
let renewLease: typeof import('./leases.ts').renewLease;
let updateLease: typeof import('./leases.ts').updateLease;

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
          data: [{ vmid: 100, node: 'pve1', type: 'qemu', status: 'running' }],
        }));
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
  await testDb.db.delete(vmLeases);
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
