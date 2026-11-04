import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createTestDatabase } from './testUtils/pgTestDb.ts';
import { pveHosts } from './db/schema/index.ts';

// Real PG for pve_hosts/provisioned_vms; only the Proxmox HTTPS layer is faked.
const testDb = await createTestDatabase();
process.env.DATABASE_URL = testDb.url;
process.env.SECRET_ENCRYPTION_KEY ||= '44'.repeat(32);

const { getNextVmid, withFreshVmid, releaseVmid } = await import('./proxmox.ts');

await testDb.db.insert(pveHosts).values({ id: 1, name: 'pve-a', host: 'a.example.com', token_id: 'r@pam!t', token_secret: 'x', verify_tls: true });

after(async () => {
  const { closeDb } = await import('./db/client.ts');
  await closeDb();
  await testDb.drop();
});

// Per-test upstream state: ids Proxmox reports as in use, and whether it errors.
let upstreamIds: number[] = [];
let resourcesFail = false;

beforeEach(() => {
  upstreamIds = [100, 101];
  resourcesFail = false;
  https.request = ((url: URL, _o: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      if (resourcesFail) { req.emit('error', new Error('ECONNREFUSED')); return; }
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      cb(res);
      const data = url.pathname.endsWith('/cluster/resources')
        ? upstreamIds.map((vmid) => ({ vmid }))
        : url.pathname.endsWith('/cluster/nextid') ? '100' : null;
      res.emit('data', JSON.stringify({ data }));
      res.emit('end');
    };
    return req;
  }) as unknown as typeof https.request;
});

test('getNextVmid skips upstream ids and hands concurrent callers distinct ids', async () => {
  const ids = await Promise.all([getNextVmid(), getNextVmid(), getNextVmid()]);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => id >= 102), `got ${ids}`);
  ids.forEach(releaseVmid);
});

test('getNextVmid refuses to allocate when a host is unreachable', async () => {
  resourcesFail = true;
  await assert.rejects(getNextVmid(), /Cannot allocate a globally unique VMID.*pve-a/);
});

test('withFreshVmid retries once with a fresh id when Proxmox says the id is taken', async () => {
  const tried: number[] = [];
  const { vmid, result } = await withFreshVmid(async (id: number) => {
    tried.push(id);
    if (tried.length === 1) throw new Error('unable to create VM 500: config file already exists');
    return 'ok';
  });
  assert.equal(tried.length, 2);
  assert.notEqual(tried[0], tried[1]);
  assert.equal(vmid, tried[1]);
  assert.equal(result, 'ok');
  releaseVmid(vmid);
});

test('withFreshVmid gives up after a second collision', async () => {
  let calls = 0;
  await assert.rejects(
    withFreshVmid(async () => { calls++; throw new Error('VM 150 already exists'); }),
    /already exists/,
  );
  assert.equal(calls, 2);
});

test('withFreshVmid releases the id after a definitive rejection (failed clone cleanup)', async () => {
  let failedId = 0;
  await assert.rejects(withFreshVmid(async (id: number) => {
    failedId = id;
    throw Object.assign(new Error('storage offline'), { definitiveRejection: true });
  }), /storage offline/);
  // Released, so the very next allocation reuses the lowest free id.
  const next = await getNextVmid();
  assert.equal(next, failedId);
  releaseVmid(next);
});

test('withFreshVmid keeps the id reserved when the outcome is unknown', async () => {
  let heldId = 0;
  await assert.rejects(withFreshVmid(async (id: number) => {
    heldId = id;
    throw new Error('socket hang up'); // submission may have reached Proxmox
  }), /socket hang up/);
  const next = await getNextVmid();
  assert.notEqual(next, heldId);
  releaseVmid(next); releaseVmid(heldId);
});

test('withFreshVmid releases the id and marks submissionStarted=false when onReserved fails', async () => {
  let reservedId = 0;
  await assert.rejects(
    withFreshVmid(async () => 'unreached', {
      onReserved: async (id: number) => { reservedId = id; throw new Error('db down'); },
    }),
    (err: Error & { submissionStarted?: boolean }) => err.message === 'db down' && err.submissionStarted === false,
  );
  const next = await getNextVmid();
  assert.equal(next, reservedId);
  releaseVmid(next);
});
