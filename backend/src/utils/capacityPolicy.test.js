// Regression coverage for the memory capacity policy (#81) — a hard block on
// `memory.free` made every overcommitted homelab node unusable for provisioning.
// Run with:  node --test src/utils/capacityPolicy.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MEMORY_MODE, DEFAULT_OVERCOMMIT_RATIO,
  evaluateMemoryCapacity, guestsOnNode, normalizeMemoryMode,
  normalizeOvercommitRatio, sumAllocatedMemoryBytes,
} from './capacityPolicy.js';

const GB = 1024 ** 3;
const gb = (n) => n * GB;
const mb = (n) => n * 1024;   // GB → MB, for requestedMb

// A 48 GB node already carrying 60 GB of configured guest RAM: over physical,
// but inside 48 × 1.5 = 72 GB of overcommit. This is the exact homelab shape
// issue #81 is about.
const homelab = {
  nodeTotalBytes: gb(48),
  allocatedBytes: gb(60),
  freeBytes: gb(0.4),         // ARC + page cache have eaten the rest
  nodeName: 'pve1',
};

test('defaults are warn / 1.5', () => {
  assert.equal(DEFAULT_MEMORY_MODE, 'warn');
  assert.equal(DEFAULT_OVERCOMMIT_RATIO, 1.5);
});

test('normalizeMemoryMode accepts the three modes and falls back to warn', () => {
  for (const v of ['off', 'warn', 'block', 'OFF', ' Block ']) {
    assert.equal(normalizeMemoryMode(v), String(v).trim().toLowerCase());
  }
  for (const v of [null, undefined, '', 'nonsense', 42, {}]) {
    assert.equal(normalizeMemoryMode(v), 'warn', `${JSON.stringify(v)} → warn`);
  }
});

test('normalizeOvercommitRatio parses numbers and strings, rejects junk', () => {
  assert.equal(normalizeOvercommitRatio(1.5), 1.5);
  assert.equal(normalizeOvercommitRatio('2'), 2);
  assert.equal(normalizeOvercommitRatio('1.25'), 1.25);
  assert.equal(normalizeOvercommitRatio(0.8), 0.8);          // reserving headroom is legal
  assert.equal(normalizeOvercommitRatio(1000), 100);         // clamped
  for (const v of [null, undefined, '', 'abc', 0, -3, NaN]) {
    assert.equal(normalizeOvercommitRatio(v), 1.5, `${JSON.stringify(v)} → default`);
  }
});

test('off mode always allows, however hopeless the request', () => {
  for (const requestedMb of [mb(1), mb(64), mb(4096)]) {
    const r = evaluateMemoryCapacity({ ...homelab, requestedMb, mode: 'off', ratio: 1 });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, '');
  }
});

test('block mode allows a request that fits inside the overcommit budget', () => {
  const r = evaluateMemoryCapacity({
    nodeTotalBytes: gb(48), allocatedBytes: gb(20), freeBytes: gb(1),
    requestedMb: mb(8), mode: 'block', ratio: 1.5, nodeName: 'pve1',
  });
  assert.equal(r.decision, 'allow');
  assert.equal(r.usableBytes, gb(72));
});

test('block mode refuses a request with no headroom left', () => {
  const r = evaluateMemoryCapacity({ ...homelab, requestedMb: mb(16), mode: 'block', ratio: 1.5 });
  assert.equal(r.decision, 'block');
  assert.equal(r.code, 'overcommit');
  assert.match(r.reason, /Not enough memory headroom on pve1/);
  assert.match(r.reason, /16\.0 GB requested/);
  assert.match(r.reason, /60\.0 GB already allocated/);
  assert.match(r.reason, /72\.0 GB usable/);
});

test('warn mode returns a warning (not a block) when headroom runs out', () => {
  const r = evaluateMemoryCapacity({ ...homelab, requestedMb: mb(16), mode: 'warn', ratio: 1.5 });
  assert.equal(r.decision, 'warn');
  assert.equal(r.code, 'overcommit');
  assert.match(r.reason, /Memory overcommitted on pve1/);
  assert.match(r.reason, /Deploying anyway/);
});

test('#81: allocated RAM above physical but under total × 1.5 still deploys', () => {
  // 8 GB on top of 60 GB allocated = 68 GB, under the 72 GB budget.
  for (const mode of ['warn', 'block']) {
    const r = evaluateMemoryCapacity({ ...homelab, requestedMb: mb(8), mode, ratio: 1.5 });
    assert.equal(r.decision, 'allow', `${mode} mode allows the overcommitted-but-budgeted case`);
    assert.equal(r.reason, '');
  }
});

test('#81 core regression: near-zero memory.free must not block on its own', () => {
  // The old check compared requested against memory.free (0.4 GB here) and
  // refused everything. With real headroom the request must sail through.
  const r = evaluateMemoryCapacity({
    nodeTotalBytes: gb(64), allocatedBytes: gb(12), freeBytes: gb(0.2),
    requestedMb: mb(8), mode: 'block', ratio: 1.5, nodeName: 'pve1',
  });
  assert.equal(r.decision, 'allow');
});

test('ratio 1.0 means "no overcommit" — allocated RAM alone fills the node', () => {
  const strict = { nodeTotalBytes: gb(48), allocatedBytes: gb(44), freeBytes: gb(2), nodeName: 'pve1' };
  assert.equal(evaluateMemoryCapacity({ ...strict, requestedMb: mb(2), mode: 'block', ratio: 1 }).decision, 'allow');
  assert.equal(evaluateMemoryCapacity({ ...strict, requestedMb: mb(8), mode: 'block', ratio: 1 }).decision, 'block');
  // …and the very same request is fine once overcommit is allowed.
  assert.equal(evaluateMemoryCapacity({ ...strict, requestedMb: mb(8), mode: 'block', ratio: 1.5 }).decision, 'allow');
});

test('a request larger than total × ratio is blocked even in warn mode', () => {
  // No amount of ballooning backs a 100 GB guest on a 48 GB node — that's a bad
  // request, not a policy judgement, so warn mode refuses it too.
  const r = evaluateMemoryCapacity({ ...homelab, requestedMb: mb(100), mode: 'warn', ratio: 1.5 });
  assert.equal(r.decision, 'block');
  assert.equal(r.code, 'exceeds-node');
  assert.match(r.reason, /pve1 cannot host a 100\.0 GB guest/);
  // …but `off` still means off.
  assert.equal(
    evaluateMemoryCapacity({ ...homelab, requestedMb: mb(100), mode: 'off', ratio: 1.5 }).decision,
    'allow',
  );
});

test('missing / NaN node memory.total skips the check instead of blocking', () => {
  for (const nodeTotalBytes of [undefined, null, NaN, 0, -1, 'lots']) {
    const r = evaluateMemoryCapacity({
      ...homelab, nodeTotalBytes, requestedMb: mb(64), mode: 'block', ratio: 1.5,
    });
    assert.equal(r.decision, 'allow', `total=${String(nodeTotalBytes)} → allow`);
    assert.equal(r.code, 'unknown-node-memory');
  }
});

test('a zero / missing memory request is never a capacity problem', () => {
  for (const requestedMb of [0, undefined, null, NaN, '']) {
    const r = evaluateMemoryCapacity({ ...homelab, requestedMb, mode: 'block', ratio: 1 });
    assert.equal(r.decision, 'allow');
    assert.equal(r.code, 'no-request');
  }
});

test('unknown allocation falls back to total − free, keeping the overcommit margin', () => {
  const args = {
    nodeTotalBytes: gb(48), allocatedBytes: null, freeBytes: gb(1),
    mode: 'block', ratio: 1.5, nodeName: 'pve1',
  };
  // total-free = 47 GB used; budget 72 GB → 8 GB still fits.
  assert.equal(evaluateMemoryCapacity({ ...args, requestedMb: mb(8) }).decision, 'allow');
  const tooBig = evaluateMemoryCapacity({ ...args, requestedMb: mb(32) });
  assert.equal(tooBig.decision, 'block');
  assert.equal(tooBig.estimatedFromFree, true);
  assert.match(tooBig.reason, /estimated from node usage/);
  // With neither allocation nor free readable, nothing is charged to the node.
  assert.equal(
    evaluateMemoryCapacity({ ...args, freeBytes: undefined, requestedMb: mb(32) }).decision,
    'allow',
  );
});

test('the node name is optional in the message', () => {
  const r = evaluateMemoryCapacity({ ...homelab, nodeName: '', requestedMb: mb(16), mode: 'block', ratio: 1.5 });
  assert.match(r.reason, /Not enough memory headroom on this node/);
});

test('sumAllocatedMemoryBytes adds configured guest RAM and skips templates', () => {
  const r = sumAllocatedMemoryBytes([
    { vmid: 100, maxmem: gb(8) },
    { vmid: 101, maxmem: gb(16) },
    { vmid: 9000, maxmem: gb(32), template: 1 },   // templates never run
  ]);
  assert.equal(r.bytes, gb(24));
  assert.equal(r.guests, 2);
  assert.equal(r.estimated, 0);
});

test('a guest missing maxmem is charged the average of its siblings', () => {
  const r = sumAllocatedMemoryBytes([
    { vmid: 100, maxmem: gb(8) },
    { vmid: 101, maxmem: gb(16) },
    { vmid: 102 },                    // no maxmem
    { vmid: 103, maxmem: 0 },         // and a useless one
    { vmid: 104, maxmem: 'nope' },
  ]);
  assert.equal(r.estimated, 3);
  assert.equal(r.bytes, gb(24) + (3 * gb(12)));   // average of 8 and 16
  // With no readable guest at all, each is charged a nominal 1 GB.
  const blind = sumAllocatedMemoryBytes([{ vmid: 100 }, { vmid: 101 }]);
  assert.equal(blind.bytes, gb(2));
  assert.equal(sumAllocatedMemoryBytes([]).bytes, 0);
  assert.equal(sumAllocatedMemoryBytes(undefined).bytes, 0);
});

test('guestsOnNode matches encoded and legacy node values, not other hosts', () => {
  const vms = [
    { vmid: 100, node: 'pve1', nodeRef: '1~pve1', maxmem: gb(8) },
    { vmid: 200, node: 'pve1', nodeRef: '2~pve1', maxmem: gb(4) },   // same name, other cluster
    { vmid: 300, node: 'pve2', nodeRef: '1~pve2', maxmem: gb(4) },
    { vmid: 400, node: 'pve1', maxmem: gb(2) },                      // legacy row, no ref
  ];
  assert.deepEqual(guestsOnNode(vms, '1~pve1').map((v) => v.vmid), [100, 400]);
  assert.deepEqual(guestsOnNode(vms, '2~pve1').map((v) => v.vmid), [200, 400]);
  assert.deepEqual(guestsOnNode(vms, 'pve1').map((v) => v.vmid), [100, 200, 400]);
  assert.deepEqual(guestsOnNode(vms, '1~pve2').map((v) => v.vmid), [300]);
  assert.deepEqual(guestsOnNode(vms, ''), []);
  assert.deepEqual(guestsOnNode(null, '1~pve1'), []);
});
