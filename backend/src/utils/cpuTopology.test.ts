import test from 'node:test';
import assert from 'node:assert/strict';
import { hasHttpStatus } from './httpError.ts';

// cpuTopology imports proxmox.ts -> db/client.ts, which throws at import without DATABASE_URL.
// The pool is lazy and these tests inject the CPU lookup, so no connection is made.
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
const { computeCpuTopology } = await import('./cpuTopology.ts');

const host = (sockets, coresPerSocket) => async () => ({ sockets, coresPerSocket });

test('spreads evenly across sockets', async () => {
  assert.deepEqual(await computeCpuTopology('n', 8, host(2, 8)), { sockets: 2, cores: 4, totalVcpus: 8, maxCores: 16 });
});

test('odd request that cannot split uses one socket', async () => {
  const r = await computeCpuTopology('n', 7, host(2, 8));
  assert.equal(r.sockets, 1);
  assert.equal(r.cores, 7);
});

test('request above physical cores rejects with 400', async () => {
  await assert.rejects(computeCpuTopology('n', 6, host(1, 4)), (err) => hasHttpStatus(err) && (err as any).status === 400);
});

test('non-HTTP lookup failure falls back to a single socket', async () => {
  const fail = async () => { throw new Error('unreachable'); };
  assert.deepEqual(await computeCpuTopology('n', 5, fail), { sockets: 1, cores: 5, totalVcpus: 5, maxCores: null });
});

test('invalid or missing cores default to 2', async () => {
  for (const v of [undefined, 'abc', 0, null]) {
    assert.equal((await computeCpuTopology('n', v, host(1, 8))).totalVcpus, 2);
  }
});
