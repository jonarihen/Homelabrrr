import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, pveHosts, provisionedVms, vmAssignments, vmLeases, vlans, userVlans, vmTemplates, cloudImages } from '../db/schema/index.ts';
import { provisionAllocation } from '../utils/provisionIntent.ts';

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
let liveVms: any[] = [];
let configName = 'new-vm';
let quota: typeof import('../utils/quota.ts');
let submitProvision: typeof import('../services/provisionOwnership.ts').submitProvision;
let reconcileInterruptedOperations: () => Promise<void>;
let runDatabaseMaintenance: typeof import('../services/databaseMaintenance.ts').runDatabaseMaintenance;
let cleanupOperationTracking: typeof import('../services/operationReconciliation.ts').cleanupOperationTracking;
const tagWrites: Record<string, unknown>[] = [];

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY = '55'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  ({ waitForBackgroundWork } = await import('../services/backgroundWork.ts'));
  const router = (await import('./provision.ts')).default;
  const operations = (await import('./operations.ts')).default;
  quota = await import('../utils/quota.ts');
  ({ submitProvision } = await import('../services/provisionOwnership.ts'));
  ({ reconcileInterruptedOperations } = await import('../db/init.ts'));
  ({ runDatabaseMaintenance } = await import('../services/databaseMaintenance.ts'));
  ({ cleanupOperationTracking } = await import('../services/operationReconciliation.ts'));
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

beforeEach(async t => {
  isAdmin = true;
  upid = 'UPID:test-create';
  task = { status: 'stopped', exitstatus: 'OK' };
  taskCalls = 0;
  tagWrites.length = 0;
  liveVms = [];
  configName = 'new-vm';
  await testDb.db.update(users).set({ max_cores: null, max_memory_gb: null, max_storage_gb: null }).where(eq(users.id, ownerId));
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
          if (path === '/api2/json/cluster/resources') data = liveVms;
          else if (path === '/api2/json/cluster/nextid') data = 100;
          else if (path === '/api2/json/nodes/pve/status') {
            data = { cpuinfo: { sockets: 1, cores: 8 }, memory: { total: 64 * 1024 ** 3 } };
          } else if (path === '/api2/json/nodes/pve/storage/local-lvm/status') data = { avail: 1024 ** 4 };
          else if ((path === '/api2/json/nodes/pve/qemu' || path.endsWith('/clone')) && options.method === 'POST') data = upid;
          else if (path.includes('/tasks/')) { taskCalls += 1; data = task; }
          else if (path.endsWith('/config') && options.method === 'GET') data = { name: configName, net0: 'virtio,bridge=vmbr0,tag=200' };
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
  const staleUsage = await quota.getUserResourceUsage(ownerId, testDb.db, []);
  const liveUsage = await quota.getUserResourceUsage(ownerId, testDb.db, [{
    vmid: created.vmid, maxcpu: 2, maxmem: 2 * 1024 ** 3, maxdisk: 20 * 1024 ** 3,
  }]);
  assert.deepEqual(staleUsage, { cores: 2, memoryGb: 2, diskGb: 20, vmCount: 1 });
  assert.deepEqual(liveUsage, staleUsage);
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

async function savedSubmission(vmid: number) {
  return submitProvision({
    user_id: adminId, node, vmid: 0, name: 'new-vm', source_type: 'create', status: 'creating',
    steps: [{ key: 'reserve', status: 'done' }, { key: 'create', status: 'active' }, { key: 'tags', status: 'pending' }],
  }, { userId: ownerId, createdBy: 'create-admin', cores: 2, memoryMb: 2048, diskGb: 20 },
  async () => ({ vmid, result: `UPID:restart-${vmid}` }));
}

test('restart retains admin assignTo intent without access and manual verified success restores ownership atomically', async () => {
  const saved = await savedSubmission(910);
  assert.equal((await provision(saved.provisionId)).user_id, adminId);
  assert.equal(provisionAllocation((await provision(saved.provisionId)).steps)?.userId, ownerId);
  await reconcileInterruptedOperations();
  assert.equal((await provision(saved.provisionId)).status, 'needs_review');
  assert.deepEqual(await ownership(910), { assignments: [], leases: [] });
  liveVms = [{ vmid: 910, node: 'pve', type: 'qemu' }];
  const response = await request(app).post(`/operations/provision/${saved.provisionId}/resolve`).send({ status: 'ready' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const owned = await ownership(910);
  assert.equal(owned.assignments[0].user_id, ownerId);
  assert.equal(owned.leases[0].created_by, 'create-admin');
  assert.equal((await provision(saved.provisionId)).status, 'ready');
  assert.equal(provisionAllocation((await provision(saved.provisionId)).steps)?.state, 'owned');
});

test('successful reconciliation after restart restores persisted ownership idempotently but leaves final configuration reviewable', async () => {
  const saved = await savedSubmission(911);
  await reconcileInterruptedOperations();
  liveVms = [{ vmid: 911, node: 'pve', type: 'qemu' }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(app).post(`/operations/provision/${saved.provisionId}/reconcile`).send({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'needs_review');
  }
  const owned = await ownership(911);
  assert.equal(owned.assignments.length, 1);
  assert.equal(owned.leases.length, 1);
  assert.equal(owned.assignments[0].user_id, ownerId);
});

test('manual ready refuses running tasks, absent VMs, name mismatch, and conflicting ownership', async () => {
  const saved = await savedSubmission(912);
  await reconcileInterruptedOperations();
  task = { status: 'running' };
  const resolve = () => request(app).post(`/operations/provision/${saved.provisionId}/resolve`).send({ status: 'ready' });
  assert.equal((await resolve()).status, 409);
  task = { status: 'stopped', exitstatus: 'OK' };
  assert.equal((await resolve()).status, 500);
  liveVms = [{ vmid: 912, node: 'pve', type: 'qemu' }];
  configName = 'different-vm';
  assert.equal((await resolve()).status, 409);
  assert.deepEqual(await ownership(912), { assignments: [], leases: [] });
  configName = 'new-vm';
  await testDb.db.insert(vmAssignments).values({ user_id: otherId, node, vmid: 912 });
  assert.equal((await resolve()).status, 409);
  assert.equal((await ownership(912)).leases.length, 0);
  assert.equal((await provision(saved.provisionId)).status, 'needs_review');
});

test('concurrent quota-limited creates admit only one reservation and release quota after task error', async () => {
  isAdmin = false;
  task = { status: 'stopped', exitstatus: 'disk failure' };
  await testDb.db.update(users).set({ max_cores: 2, max_memory_gb: 2, max_storage_gb: 20 }).where(eq(users.id, ownerId));
  const responses = await Promise.all([1, 2].map(() => request(app).post('/provision/create').send({ node, name: 'new-vm', vlanTag: 200 })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 403]);
  assert.deepEqual(await quota.getUserResourceUsage(ownerId), { cores: 2, memoryGb: 2, diskGb: 20, vmCount: 1 });
  assert.equal((await testDb.db.select().from(vmAssignments)).length, 0);
  await waitForBackgroundWork();
  assert.deepEqual(await quota.getUserResourceUsage(ownerId), { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 });
  await create({ vlanTag: 200 });
  await waitForBackgroundWork();
});

test('pending and interrupted allocations enforce each resource limit and release on confirmed failure', async () => {
  const saved = await savedSubmission(913);
  await testDb.db.update(users).set({ max_cores: 2, max_memory_gb: 2, max_storage_gb: 20 }).where(eq(users.id, ownerId));
  await assert.rejects(quota.assertUserQuota(ownerId, { addCores: 1 }), /CPU quota exceeded/);
  await assert.rejects(quota.assertUserQuota(ownerId, { addMemoryMb: 1 }), /Memory quota exceeded/);
  await assert.rejects(quota.assertUserQuota(ownerId, { addDiskGb: 1 }), /Storage quota exceeded/);
  await reconcileInterruptedOperations();
  await assert.rejects(quota.assertUserQuota(ownerId, { addCores: 1 }), /CPU quota exceeded/);
  task = { status: 'stopped', exitstatus: 'create failed' };
  const response = await request(app).post(`/operations/provision/${saved.provisionId}/reconcile`).send({});
  assert.equal(response.status, 200);
  await quota.assertUserQuota(ownerId, { addCores: 2, addMemoryMb: 2048, addDiskGb: 20 });
});

test('timeout reservations survive tracking cleanup and retention until an operator verifies the result', async () => {
  const saved = await savedSubmission(914);
  await testDb.db.update(provisionedVms).set({ status: 'timeout', created_at: new Date('2020-01-01') })
    .where(eq(provisionedVms.id, saved.provisionId));
  assert.equal((await cleanupOperationTracking(testDb.db, 'provision', saved.provisionId)).blocked, true);
  await runDatabaseMaintenance();
  assert.ok(await provision(saved.provisionId));
  assert.deepEqual(await quota.getUserResourceUsage(ownerId), { cores: 2, memoryGb: 2, diskGb: 20, vmCount: 1 });
});

test('clone and cloud-image submission persist the same owner intent and pending resource reservation', async () => {
  task = { status: 'stopped', exitstatus: 'deployment failed' };
  const [template] = await testDb.db.insert(vmTemplates).values({ name: 'quota-template', node, vmid: 500 })
    .returning({ id: vmTemplates.id });
  const [image] = await testDb.db.insert(cloudImages).values({
    name: 'quota-image', url: 'https://example.com/cloud.qcow2', node, storage: 'local',
    volid: 'local:import/cloud.qcow2', default_storage: 'local-lvm', status: 'ready',
  }).returning({ id: cloudImages.id });
  for (const [route, body] of [
    ['/clone', { templateId: template.id }],
    ['/from-image', { imageId: image.id, ciPassword: 'a-strong-cloud-password' }],
  ] as const) {
    const response = await request(app).post(`/provision${route}`).send({ ...body, name: 'new-vm', assignTo: ownerId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = await provision(response.body.id);
    assert.equal(row.user_id, adminId);
    assert.equal(provisionAllocation(row.steps)?.userId, ownerId);
    assert.equal(provisionAllocation(row.steps)?.diskGb, 20);
    assert.deepEqual(await ownership(response.body.vmid), { assignments: [], leases: [] });
  }
  await waitForBackgroundWork();
  assert.deepEqual(await quota.getUserResourceUsage(ownerId), { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 });
});

test('synchronous upstream rejection releases its reservation', async () => {
  await assert.rejects(submitProvision({
    user_id: adminId, node, vmid: 0, name: 'new-vm', status: 'creating', steps: [{ key: 'reserve' }],
  }, { userId: ownerId, createdBy: 'create-admin', cores: 2, memoryMb: 2048, diskGb: 20 },
  async () => { throw new Error('submission rejected'); }), /submission rejected/);
  assert.deepEqual(await quota.getUserResourceUsage(ownerId), { cores: 0, memoryGb: 0, diskGb: 0, vmCount: 0 });
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
