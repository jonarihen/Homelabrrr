import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { users, pveHosts, vmAssignments, auditLog } from '../db/schema/index.ts';

// DELETE /vms/:node/:vmid/disks/:disk — owner-only, never the boot disk, stopped VMs only,
// and the deleted volume stops counting against the owner's storage quota.
let testDb: TestDatabase;
let app: express.Express;
let closeDb: (() => Promise<void>) | undefined;
let node: string;
let ownerId: number;
let operatorId: number;
let sessionUserId: number;
let vmStatus = 'stopped';
let snapshots: { name: string }[] = [{ name: 'current' }];
let quota: typeof import('../utils/quota.ts');
const unlinks: { path: string; method: string; body: string }[] = [];

const CONFIG = {
  boot: 'order=scsi0;ide2;net0',
  scsi0: 'local-lvm:vm-500-disk-0,size=20G',
  scsi1: 'local-lvm:vm-500-disk-1,size=10G',
  ide2: 'local-lvm:vm-500-cloudinit,media=cdrom',
  net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
};

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '77'.repeat(32);
  ({ closeDb } = await import('../db/client.ts'));
  quota = await import('../utils/quota.ts');
  const rows = await testDb.db.insert(users).values([
    { username: 'disk-owner', password: 'x', can_edit_vm_hardware: true },
    // Fleet-wide operator with hardware rights: still not the owner.
    { username: 'disk-operator', password: 'x', can_edit_vm_hardware: true, can_operate_all_vms: true, see_all_vms: true },
  ]).returning({ id: users.id });
  [ownerId, operatorId] = rows.map(row => row.id);
  const [host] = await testDb.db.insert(pveHosts).values({
    name: 'disk-pve', host: 'pve.example', token_id: 'test@pve!portal', token_secret: 'test-secret',
  }).returning({ id: pveHosts.id });
  node = `${host.id}~pve`;
  await testDb.db.insert(vmAssignments).values({
    user_id: ownerId, node, vmid: 500, resource_allocation: { cores: 2, memoryMb: 2048, diskGb: 30 },
  });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: sessionUserId, username: 'disk-user', isAdmin: false, reauthenticatedAt: Date.now() } as never;
    next();
  });
  app.use('/vms', (await import('./vms.ts')).default);
});

beforeEach(t => {
  sessionUserId = ownerId;
  vmStatus = 'stopped';
  snapshots = [{ name: 'current' }];
  unlinks.length = 0;
  t.mock.method(https, 'request', (url: URL, options: { method?: string }, callback: (res: EventEmitter) => void) => {
    const outgoing = new EventEmitter();
    let body = '';
    return Object.assign(outgoing, {
      write(chunk: string) { body += chunk; }, setTimeout() {}, destroy(err: Error) { outgoing.emit('error', err); },
      end(chunk?: string) {
        if (chunk) body += chunk;
        queueMicrotask(() => {
          const socket = Object.assign(new EventEmitter(), { encrypted: true, connecting: true, authorized: false });
          outgoing.emit('socket', socket);
          socket.emit('secureConnect');
          const incoming = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(incoming);
          const path = url.pathname;
          let data: unknown = null;
          if (path === '/api2/json/nodes') data = [{ node: 'pve' }];
          else if (path === '/api2/json/cluster/resources') data = [{ vmid: 500, node: 'pve', type: 'qemu' }];
          else if (path.endsWith('/qemu/500/config')) data = CONFIG;
          else if (path.endsWith('/qemu/500/status/current')) data = { status: vmStatus };
          else if (path.endsWith('/qemu/500/snapshot')) data = snapshots;
          else if (path.endsWith('/qemu/500/unlink')) unlinks.push({ path, method: options?.method || '', body });
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

const remove = (disk: string) => request(app).delete(`/vms/${node}/500/disks/${encodeURIComponent(disk)}`);

test('a fleet operator who does not own the VM may not remove its disks', async () => {
  sessionUserId = operatorId;
  assert.equal((await remove('scsi1')).status, 403);
  assert.equal(unlinks.length, 0);
});

test('malformed or non-removable disk keys are refused before any change', async () => {
  for (const disk of ['efidisk0', 'scsi1,force=1', 'scsi', 'net0', '../scsi1']) {
    assert.equal((await remove(disk)).status, 400, disk);
  }
  // The cloud-init drive matches the key format but is not a data disk.
  assert.equal((await remove('ide2')).status, 400);
  assert.equal((await remove('scsi9')).status, 404);
  assert.equal(unlinks.length, 0);
});

test('the boot disk is refused', async () => {
  const res = await remove('scsi0');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /boot disk/);
  assert.equal(unlinks.length, 0);
});

test('a running VM is refused', async () => {
  vmStatus = 'running';
  const res = await remove('scsi1');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Stop the VM/);
  assert.equal(unlinks.length, 0);
});

test('a VM with snapshots is refused, since PVE would keep the volume', async () => {
  snapshots = [{ name: 'before-upgrade' }, { name: 'current' }];
  const res = await remove('scsi1');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /snapshots/);
  assert.equal(unlinks.length, 0);
});

test('the owner removes a data disk, the volume is deleted and the quota freed', async () => {
  const res = await remove('scsi1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(unlinks.length, 1);
  assert.equal(unlinks[0].method, 'PUT');
  assert.match(unlinks[0].body, /idlist.*scsi1/);
  assert.match(unlinks[0].body, /force.*1/);
  const [row] = await testDb.db.select().from(vmAssignments).where(eq(vmAssignments.vmid, 500));
  assert.equal(row.resource_allocation?.diskGb, 20);
  assert.equal((await quota.getUserResourceUsage(ownerId, testDb.db, [])).diskGb, 20);
  const audit = await testDb.db.select().from(auditLog).where(eq(auditLog.action, 'vm_disk_remove'));
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail || '', /scsi1 \(local-lvm:vm-500-disk-1\)/);
});
