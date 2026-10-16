import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
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
  await testDb.db.insert(vmAssignments).values({ user_id: user.id, node, vmid: 300 });
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

beforeEach(t => {
  pveCalls = 0;
  t.mock.method(https, 'request', () => { pveCalls += 1; throw new Error('unexpected PVE call'); });
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
