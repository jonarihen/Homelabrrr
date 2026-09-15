import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { resolveRestoreGuestType } from './utils/backupGuestType.ts';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.SECRET_ENCRYPTION_KEY ||= '44'.repeat(32);

const { db } = await import('./db/client.ts');
const { restoreVMBackup } = await import('./proxmox.ts');

interface CapturedRequest {
  url: string;
  pathname: string;
  method: string;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
}

let captured: CapturedRequest | null = null;

beforeEach(() => {
  captured = null;

  db.select = (() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{
          id: 1,
          name: 'pve-test',
          host: 'pve.example.com',
          port: 8006,
          token_id: 'root@pam!token',
          token_secret: 'test-secret',
          verify_tls: true,
        }],
      }),
    }),
  })) as typeof db.select;

  https.request = ((url: URL | string, options: https.RequestOptions, cb?: (res: EventEmitter & { statusCode?: number }) => void) => {
    const targetUrl = typeof url === 'string' ? new URL(url) : url;
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, fn?: () => void) => void;
      destroy: (err?: Error) => void;
      write: (chunk: string | Buffer) => void;
      end: () => void;
    };
    let bodyText = '';
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = (chunk: string | Buffer) => {
      bodyText += chunk.toString();
    };
    req.end = () => {
      captured = {
        url: targetUrl.toString(),
        pathname: targetUrl.pathname,
        method: options.method || 'GET',
        headers: (options.headers || {}) as Record<string, unknown>,
        body: bodyText ? JSON.parse(bodyText) : {},
      };
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      if (cb) cb(res);
      res.emit('data', JSON.stringify({ data: 'UPID:pve1:00001:restore' }));
      res.emit('end');
    };
    return req as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
});

test('restoreVMBackup routes QEMU classic vzdump to /qemu with archive and force', async () => {
  const upid = await restoreVMBackup('1~pve1', '100', 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst', 'local-lvm', 'qemu');

  assert.equal(upid, 'UPID:pve1:00001:restore');
  assert.ok(captured);
  assert.equal(captured.pathname, '/api2/json/nodes/pve1/qemu');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, {
    vmid: 100,
    archive: 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst',
    force: 1,
    storage: 'local-lvm',
  });
  assert.equal('ostemplate' in captured.body, false);
  assert.equal('restore' in captured.body, false);
});

test('restoreVMBackup routes QEMU PBS backup to /qemu without storage when unspecified', async () => {
  await restoreVMBackup('1~pve1', 100, 'pbs-store:backup/vm/100/2026-07-06T22:37:18Z', undefined, 'qemu');

  assert.ok(captured);
  assert.equal(captured.pathname, '/api2/json/nodes/pve1/qemu');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, {
    vmid: 100,
    archive: 'pbs-store:backup/vm/100/2026-07-06T22:37:18Z',
    force: 1,
  });
  assert.equal('storage' in captured.body, false);
  assert.equal('ostemplate' in captured.body, false);
  assert.equal('restore' in captured.body, false);
});

test('restoreVMBackup routes LXC classic vzdump to /lxc with ostemplate, restore and force', async () => {
  const upid = await restoreVMBackup('1~pve1', '101', 'local:backup/vzdump-lxc-101-2026_07_01-00_00_00.tar.zst', 'local-zfs', 'lxc');

  assert.equal(upid, 'UPID:pve1:00001:restore');
  assert.ok(captured);
  assert.equal(captured.pathname, '/api2/json/nodes/pve1/lxc');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, {
    vmid: 101,
    ostemplate: 'local:backup/vzdump-lxc-101-2026_07_01-00_00_00.tar.zst',
    restore: 1,
    force: 1,
    storage: 'local-zfs',
  });
  assert.equal('archive' in captured.body, false);
});

test('restoreVMBackup routes LXC PBS backup to /lxc without storage when unspecified', async () => {
  await restoreVMBackup('1~pve1', 101, 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z', undefined, 'lxc');

  assert.ok(captured);
  assert.equal(captured.pathname, '/api2/json/nodes/pve1/lxc');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, {
    vmid: 101,
    ostemplate: 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z',
    restore: 1,
    force: 1,
  });
  assert.equal('storage' in captured.body, false);
  assert.equal('archive' in captured.body, false);
});

test('restoreVMBackup defaults vmtype to qemu when omitted', async () => {
  await restoreVMBackup('1~pve1', 100, 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst');

  assert.ok(captured);
  assert.equal(captured.pathname, '/api2/json/nodes/pve1/qemu');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, {
    vmid: 100,
    archive: 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst',
    force: 1,
  });
  assert.equal('ostemplate' in captured.body, false);
  assert.equal('restore' in captured.body, false);
});

test('restoreVMBackup integrates with resolveRestoreGuestType for LXC and QEMU backups', async () => {
  const lxcResolved = resolveRestoreGuestType({
    volid: 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z',
    detected: 'lxc',
    vmid: 101,
  });
  assert.equal(lxcResolved.vmtype, 'lxc');
  await restoreVMBackup('1~pve1', 101, 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z', 'local-zfs', lxcResolved.vmtype);
  assert.ok(captured);
  assert.equal(captured.pathname, '/api2/json/nodes/pve1/lxc');
  assert.equal(captured.body.ostemplate, 'pbs-store:backup/ct/101/2026-07-06T22:37:18Z');
  assert.equal(captured.body.restore, 1);
  assert.equal('archive' in captured.body, false);

  const qemuResolved = resolveRestoreGuestType({
    volid: 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst',
    detected: 'qemu',
    vmid: 100,
  });
  assert.equal(qemuResolved.vmtype, 'qemu');
  await restoreVMBackup('1~pve1', 100, 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst', 'local-lvm', qemuResolved.vmtype);
  assert.ok(captured);
  assert.equal(captured.pathname, '/api2/json/nodes/pve1/qemu');
  assert.equal(captured.body.archive, 'local:backup/vzdump-qemu-100-2026_07_01-00_00_00.vma.zst');
  assert.equal('ostemplate' in captured.body, false);
  assert.equal('restore' in captured.body, false);
});
