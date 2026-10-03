import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, pveHosts, provisionedVms, vmAssignments, vmLeases, vlans, userVlans } from '../db/schema/index.ts';

let testDb: TestDatabase;
let app: express.Express;
let closeDb: () => Promise<void>;
let waitForBackgroundWork: () => Promise<void>;
let node: string;
let adminId: number;
let ownerId: number;
let otherId: number;
let isAdmin = true;
let upid: string | null = 'UPID:test-create';
let task: Record<string, unknown> = { status: 'stopped', exitstatus: 'OK' };
let taskCalls = 0;
const tagWrites: Record<string, unknown>[] = [];

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY = '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ waitForBackgroundWork } = await import('../services/backgroundWork.ts'));
  const router = (await import('./provision.ts')).default;
  const operations = (await import('./operations.ts')).default;
  const rows = await testDb.db.insert(users).values([
    { username: 'create-admin', password: 'x', is_admin: true },
    { username: 'create-owner', password: 'x', can_create_vms: true },
    { username: 'other-owner', password: 'x' },
  ]).returning({ id: users.id });
  [adminId, ownerId, otherId] = rows.map(row => row.id);
  const [host] = await testDb.db.insert(pveHosts).values({
    name: 'fake-create-pve', host: 'pve.example', token_id: 'test@pve!portal', token_secret: 'test-secret',
  }).returning({ id: pveHosts.id });
  node = `${host.id}~pve`;
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'create-network', tag: 200 })
    .returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: ownerId, vlan_id: vlan.id });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      userId: isAdmin ? adminId : ownerId,
      username: isAdmin ? 'create-admin' : 'create-owner',
      isAdmin,
      reauthenticatedAt: Date.now(),
    };
    next();
  });
  app.use('/provision', router);
  app.use('/operations', operations);
});

beforeEach(t => {
  isAdmin = true;
  upid = 'UPID:test-create';
  task = { status: 'stopped', exitstatus: 'OK' };
  taskCalls = 0;
  tagWrites.length = 0;
  t.mock.method(https, 'request', (url: URL, options: any, callback: any) => {
    const outgoing = new EventEmitter();
    let body = '';
    return Object.assign(outgoing, {
      write(chunk: string) { body += chunk; },
      setTimeout() {},
      destroy(err: Error) { outgoing.emit('error', err); },
      end() {
        queueMicrotask(() => {
          let data: unknown;
          const path = url.pathname;
          if (path === '/api2/json/cluster/resources') data = [];
          else if (path === '/api2/json/cluster/nextid') data = 100;
          else if (path === '/api2/json/nodes/pve/status') {
            data = { cpuinfo: { sockets: 1, cores: 8 }, memory: { total: 64 * 1024 ** 3 } };
          } else if (path === '/api2/json/nodes/pve/storage/local-lvm/status') data = { avail: 1024 ** 4 };
          else if (path === '/api2/json/nodes/pve/qemu' && options.method === 'POST') data = upid;
          else if (path.includes('/tasks/')) { taskCalls += 1; data = task; }
          else if (path.endsWith('/config') && options.method === 'GET') data = { net0: 'virtio,bridge=vmbr0,tag=200' };
          else if (path.endsWith('/config') && options.method === 'PUT') { tagWrites.push(JSON.parse(body)); data = null; }
          else assert.fail(`Unexpected PVE request: ${options.method} ${url}`);
          const incoming = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(incoming);
          incoming.emit('data', JSON.stringify({ data }));
          incoming.emit('end');
        });
      },
    });
  });
});

afterEach(async () => {
  await waitForBackgroundWork();
  await testDb.db.transaction(async tx => {
    await tx.delete(vmAssignments);
    await tx.delete(vmLeases);
    await tx.delete(provisionedVms);
  });
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

async function create(extra: Record<string, unknown> = {}) {
  const response = await request(app).post('/provision/create').send({ node, name: 'new-vm', assignTo: ownerId, ...extra });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function ownership(vmid: number) {
  return {
    assignments: await testDb.db.select().from(vmAssignments).where(eq(vmAssignments.vmid, vmid)),
    leases: await testDb.db.select().from(vmLeases).where(eq(vmLeases.vmid, vmid)),
  };
}

async function provision(id: number) {
  const [row] = await testDb.db.select().from(provisionedVms).where(eq(provisionedVms.id, id));
  return row;
}

test('failed create task records its error but never creates assignment, lease, or tags', async () => {
  task = { status: 'stopped', exitstatus: 'unable to allocate disk' };
  const created = await create();
  assert.deepEqual(await ownership(created.vmid), { assignments: [], leases: [] });
  await waitForBackgroundWork();
  assert.equal(taskCalls, 1);
  assert.deepEqual(await ownership(created.vmid), { assignments: [], leases: [] });
  assert.deepEqual(tagWrites, []);
  const row = await provision(created.id);
  assert.equal(row.status, 'error');
  assert.equal(row.status_detail, 'unable to allocate disk');
  assert.equal((row.steps as any[]).find(step => step.key === 'create').status, 'error');
  assert.equal((row.steps as any[]).find(step => step.key === 'tags').status, 'pending');
});

test('a stopped create task without an OK exit status cannot grant ownership', async () => {
  task = { status: 'stopped' };
  const created = await create();
  await waitForBackgroundWork();
  assert.deepEqual(await ownership(created.vmid), { assignments: [], leases: [] });
  assert.equal((await provision(created.id)).status_detail, 'Task failed');
});

test('a timed-out create never creates ownership while the upstream task is still running', async t => {
  task = { status: 'running' };
  const setTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: any, delay: number, ...args: any[]) =>
    setTimeout(callback, delay === 5000 ? 1 : delay, ...args));
  const created = await create();
  await waitForBackgroundWork();
  assert.equal(taskCalls, 120);
  assert.deepEqual(await ownership(created.vmid), { assignments: [], leases: [] });
  assert.deepEqual(tagWrites, []);
  assert.equal((await provision(created.id)).status, 'timeout');
});

test('successful create records ownership only after completion and before owner tag sync', async () => {
  const created = await create();
  assert.deepEqual(await ownership(created.vmid), { assignments: [], leases: [] });
  const completedAfter = Date.now();
  await waitForBackgroundWork();
  const rows = await ownership(created.vmid);
  assert.equal(rows.assignments.length, 1);
  assert.equal(rows.assignments[0].user_id, ownerId);
  assert.equal(rows.assignments[0].node, node);
  assert.equal(rows.leases.length, 1);
  assert.equal(rows.leases[0].created_by, 'create-admin');
  assert.ok(rows.leases[0].started_at!.getTime() >= completedAfter);
  assert.ok(String(tagWrites[0].tags).includes('create-owner'));
  assert.equal((await provision(created.id)).status, 'ready');
});

test('an admin create without an assignment still starts a lease after success', async () => {
  const created = await create({ assignTo: null });
  assert.deepEqual(await ownership(created.vmid), { assignments: [], leases: [] });
  await waitForBackgroundWork();
  const rows = await ownership(created.vmid);
  assert.equal(rows.assignments.length, 0);
  assert.equal(rows.leases.length, 1);
  assert.equal((await provision(created.id)).status, 'ready');
});

test('non-admin create ignores assignTo and self-assigns only after success', async () => {
  isAdmin = false;
  const created = await create({ assignTo: otherId, vlanTag: 200 });
  assert.deepEqual(await ownership(created.vmid), { assignments: [], leases: [] });
  await waitForBackgroundWork();
  const rows = await ownership(created.vmid);
  assert.equal(rows.assignments[0].user_id, ownerId);
  assert.equal(rows.leases[0].created_by, 'create-owner');
});

test('a synchronous create response still records ownership and lease', async () => {
  upid = null;
  const created = await create();
  await waitForBackgroundWork();
  const rows = await ownership(created.vmid);
  assert.equal(rows.assignments[0].user_id, ownerId);
  assert.equal(rows.leases.length, 1);
  assert.equal(taskCalls, 0);
  assert.equal((await provision(created.id)).status, 'ready');
});

test('failed-create reconciliation reports legacy rows and reuse history without deleting legitimate ownership', async () => {
  const [failed] = await testDb.db.insert(provisionedVms).values({
    user_id: adminId, node, vmid: 900, name: 'failed-create', source_type: 'create', status: 'timeout', upid: 'UPID:old-create',
  }).returning({ id: provisionedVms.id });
  await testDb.db.insert(provisionedVms).values({
    user_id: otherId, node, vmid: 900, name: 'reused-vm', source_type: 'create', status: 'ready', upid: 'UPID:later-create',
  });
  await testDb.db.insert(vmAssignments).values({ user_id: otherId, node: 'pve', vmid: 900 });
  await testDb.db.insert(vmLeases).values({ node, vmid: 900, created_by: 'other-owner', renewal_count: 2 });
  const before = await ownership(900);
  task = { status: 'stopped', exitstatus: 'create failed' };
  const response = await request(app).post(`/operations/provision/${failed.id}/reconcile`).send({});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'error');
  assert.equal(response.body.ownershipReview.automaticCleanup, false);
  assert.equal(response.body.ownershipReview.assignments[0].user_id, otherId);
  assert.equal(response.body.ownershipReview.leases[0].renewal_count, 2);
  assert.equal(response.body.ownershipReview.history.length, 2);
  assert.match(response.body.ownershipReview.detail, /does not prove absence/);
  assert.deepEqual(await ownership(900), before);
});

test('successful upstream reconciliation does not classify existing ownership as failed-create leftovers', async () => {
  const [saved] = await testDb.db.insert(provisionedVms).values({
    user_id: adminId, node, vmid: 901, name: 'interrupted-create', source_type: 'create', status: 'needs_review', upid: 'UPID:saved-create',
  }).returning({ id: provisionedVms.id });
  await testDb.db.insert(vmAssignments).values({ user_id: ownerId, node, vmid: 901 });
  await testDb.db.insert(vmLeases).values({ node, vmid: 901, created_by: 'create-admin' });
  const before = await ownership(901);
  const response = await request(app).post(`/operations/provision/${saved.id}/reconcile`).send({});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'needs_review');
  assert.equal(response.body.ownershipReview, null);
  assert.deepEqual(await ownership(901), before);
});
