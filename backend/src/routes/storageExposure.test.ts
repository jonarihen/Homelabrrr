import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, pveHosts, storageVisibility, vmAssignments, cloudImages, vlans, userVlans } from '../db/schema/index.ts';

// Every path that names a storage pool must refuse a pool the admin hid, and
// identifiers headed for PVE property strings must be strict — all before any
// upstream call is made.
let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let node: string;
let imageId: number;
let pveCalls = 0;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '66'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  const [user] = await testDb.db.insert(users).values({
    username: 'storage-member', password: 'x', can_create_vms: true, can_manage_templates: true,
  }).returning({ id: users.id });
  const [host] = await testDb.db.insert(pveHosts).values({
    name: 'storage-pve', host: 'pve.example', token_id: 'test@pve!portal', token_secret: 'test-secret',
  }).returning({ id: pveHosts.id });
  node = `${host.id}~pve`;
  await testDb.db.insert(storageVisibility).values([
    { pve_host_id: host.id, storage: 'hidden', exposed: false },
  ]);
  // A second cluster with the same node name makes the legacy bare name "pve" ambiguous.
  await testDb.db.insert(pveHosts).values({
    name: 'other-pve', host: 'other.example', token_id: 'test@pve!portal', token_secret: 'test-secret',
  });
  await testDb.db.insert(vmAssignments).values([
    { user_id: user.id, node, vmid: 300 },
    { user_id: user.id, node: 'pve', vmid: 301 },
  ]);
  const [vlan] = await testDb.db.insert(vlans).values({ name: 'member-net', tag: 200 }).returning({ id: vlans.id });
  await testDb.db.insert(userVlans).values({ user_id: user.id, vlan_id: vlan.id });
  const [image] = await testDb.db.insert(cloudImages).values({
    name: 'debian', url: 'https://example.test/debian.qcow2', node, storage: 'local',
    volid: 'local:import/debian.qcow2', status: 'ready',
  }).returning({ id: cloudImages.id });
  imageId = image.id;

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: user.id, username: 'storage-member', isAdmin: false, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/provision', (await import('./provision.ts')).default);
  app.use('/vms', (await import('./vms.ts')).default);
  app.use('/cloud-images', (await import('./cloudimages.ts')).default);
});

// Only the node and cluster resource listings (used to place a legacy VMID) are served;
// any other upstream call counts as a failure.
beforeEach(t => {
  pveCalls = 0;
  t.mock.method(https, 'request', (url: URL, _options: unknown, callback: (res: EventEmitter) => void) => {
    if (!['/api2/json/nodes', '/api2/json/cluster/resources'].includes(url.pathname)) { pveCalls += 1; throw new Error('unexpected PVE call'); }
    const outgoing = new EventEmitter();
    return Object.assign(outgoing, {
      write() {}, setTimeout() {}, destroy(err: Error) { outgoing.emit('error', err); },
      end() {
        queueMicrotask(() => {
          const socket = Object.assign(new EventEmitter(), { encrypted: true, connecting: true, authorized: false });
          outgoing.emit('socket', socket);
          socket.emit('secureConnect');
          const incoming = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(incoming);
          const data = url.pathname === '/api2/json/nodes' ? [{ node: 'pve' }]
            : url.hostname === 'pve.example' ? [{ vmid: 301, node: 'pve', type: 'qemu' }] : [];
          incoming.emit('data', JSON.stringify({ data }));
          incoming.emit('end');
        });
      },
    });
  });
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('create refuses non-ISO volumes, extra options and ISOs on a hidden pool', async () => {
  const create = (iso: string) => request(app).post('/provision/create').send({ node, name: 'vm', storage: 'local', vlanTag: 200, iso });
  assert.equal((await create('local:300/vm-300-disk-0.raw')).status, 400);
  assert.equal((await create('local:iso/a.iso,media=disk')).status, 400);
  const hidden = await create('hidden:iso/a.iso');
  assert.equal(hidden.status, 403);
  assert.match(hidden.body.error, /Storage pool "hidden"/);
  assert.equal(pveCalls, 0);
});

test('backup and restore refuse a hidden target storage', async () => {
  const backup = await request(app).post(`/vms/${node}/300/backup`).send({ storage: 'hidden' });
  assert.equal(backup.status, 403);
  assert.match(backup.body.error, /Storage pool "hidden"/);
  const restore = await request(app).post(`/vms/${node}/300/restore`)
    .send({ archive: 'local:backup/vzdump-qemu-300-2026_01_01-00_00_00.vma.zst', storage: 'hidden' });
  assert.equal(restore.status, 403);
  assert.match(restore.body.error, /Storage pool "hidden"/);
  assert.equal(pveCalls, 0);
});

test('template-from-image validates storage/bridge identifiers and refuses hidden storage', async () => {
  const build = (body: Record<string, unknown>) => request(app).post(`/cloud-images/${imageId}/template`).send({ name: 't', ...body });
  assert.equal((await build({ storage: 'local', bridge: 'vmbr0,tag=666' })).status, 400);
  assert.equal((await build({ storage: 'local,size=1' })).status, 400);
  const hidden = await build({ storage: 'hidden' });
  assert.equal(hidden.status, 403);
  assert.match(hidden.body.error, /Storage pool "hidden"/);
  assert.equal(pveCalls, 0);
});

test('storage given as a non-string is rejected instead of slipping past the exposure check', async () => {
  const build = await request(app).post(`/cloud-images/${imageId}/template`).send({ name: 't', storage: ['hidden'] });
  assert.equal(build.status, 400);
  const create = await request(app).post('/provision/create').send({ node, name: 'vm', storage: ['hidden'], vlanTag: 200 });
  assert.equal(create.status, 400);
  assert.equal((await request(app).post('/provision/create').send({ node, name: 'vm', storage: 'local', vlanTag: 200, iso: ['hidden:iso/a.iso'] })).status, 400);
  assert.equal((await request(app).post(`/vms/${node}/300/backup`).send({ storage: ['hidden'] })).status, 400);
  const restore = await request(app).post(`/vms/${node}/300/restore`)
    .send({ archive: 'local:backup/vzdump-qemu-300-2026_01_01-00_00_00.vma.zst', storage: ['hidden'] });
  assert.equal(restore.status, 400);
  assert.equal(pveCalls, 0);
});

test('a legacy bare node name shared by two clusters is resolved through the VMID', async () => {
  const backup = await request(app).post('/vms/pve/301/backup').send({ storage: 'hidden' });
  assert.equal(backup.status, 403, JSON.stringify(backup.body));
  assert.match(backup.body.error, /Storage pool "hidden"/);
  assert.equal(pveCalls, 0);
});
