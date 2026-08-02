// Regression coverage for VMID allocation (issue #77 — TOCTOU race where two
// concurrent deploys were handed the same VMID).
// Run with:  node --test src/utils/vmidAllocator.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickVmid, isVmidTakenError, VmidReservations, VMID_MIN, VMID_RESERVATION_TTL_MS,
} from './vmidAllocator.js';

// A reservation set driven by a hand-cranked clock, so TTL behavior is testable
// without real timers.
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

test('picks the first free id starting at 100 when nothing is used', () => {
  assert.equal(pickVmid(new Set(), new Set()), 100);
  assert.equal(VMID_MIN, 100);
});

test('skips ids already used upstream', () => {
  assert.equal(pickVmid([100, 101, 103], []), 102);
  assert.equal(pickVmid([100], []), 101);
});

test('skips ids held by an in-flight reservation', () => {
  // 100 is free upstream but another deploy is holding it — this is the bug.
  assert.equal(pickVmid([], [100]), 101);
  assert.equal(pickVmid([100, 102], [101]), 103);
});

test('two sequential allocations never collide against the same snapshot', () => {
  // Reproduces the race: both callers see the same /cluster/resources snapshot.
  const used = new Set([100, 101]);
  const reservations = new VmidReservations();

  const first = pickVmid(used, reservations.active());
  reservations.reserve(first);
  const second = pickVmid(used, reservations.active());
  reservations.reserve(second);
  const third = pickVmid(used, reservations.active());

  assert.equal(first, 102);
  assert.equal(second, 103);
  assert.equal(third, 104);
  assert.notEqual(first, second);
  assert.equal(reservations.size, 2);
});

test('releasing a reservation makes the id available again', () => {
  const used = new Set([100]);
  const reservations = new VmidReservations();

  const first = pickVmid(used, reservations.active());
  reservations.reserve(first);
  assert.equal(first, 101);
  assert.equal(pickVmid(used, reservations.active()), 102);

  // Failed deploy → release, so the id isn't burned for the full TTL.
  assert.equal(reservations.release(first), true);
  assert.equal(reservations.size, 0);
  assert.equal(pickVmid(used, reservations.active()), 101);
});

test('a reservation expires after the TTL', () => {
  const clock = fakeClock();
  const reservations = new VmidReservations({ ttlMs: 60_000, now: clock.now });
  reservations.reserve(105);

  assert.equal(reservations.has(105), true);
  clock.advance(59_999);
  assert.equal(reservations.has(105), true, 'still held just before the TTL');

  clock.advance(1);
  assert.equal(reservations.has(105), false, 'released once the TTL elapses');
  assert.equal(reservations.size, 0);
  assert.equal(pickVmid([100, 101], reservations.active()), 102);
});

test('the default TTL is five minutes', () => {
  assert.equal(VMID_RESERVATION_TTL_MS, 5 * 60 * 1000);
  const clock = fakeClock();
  const reservations = new VmidReservations({ now: clock.now });
  reservations.reserve(100);
  clock.advance(VMID_RESERVATION_TTL_MS - 1);
  assert.equal(reservations.has(100), true);
  clock.advance(1);
  assert.equal(reservations.has(100), false);
});

test('a fully contiguous used range picks the next id above it', () => {
  const used = new Set();
  for (let id = 100; id <= 150; id++) used.add(id);
  assert.equal(pickVmid(used, []), 151);

  // …and reservations stack on top of the contiguous range.
  assert.equal(pickVmid(used, [151, 152]), 153);
});

test('startAt is honored but never drops below the Proxmox minimum', () => {
  // /cluster/nextid fallback path — used when no host reports any guest.
  assert.equal(pickVmid([], [], 9000), 9000);
  assert.equal(pickVmid([9000], [9001], 9000), 9002);
  for (const low of [0, 1, 99, null, undefined, 'nope']) {
    assert.equal(pickVmid([], [], low), 100, `startAt ${JSON.stringify(low)} clamps to 100`);
  }
});

test('reservations normalize string ids and ignore junk', () => {
  const reservations = new VmidReservations();
  assert.equal(reservations.reserve('107'), 107);
  assert.equal(reservations.has(107), true);
  assert.equal(pickVmid([], reservations.active(), 107), 108);
  assert.equal(reservations.release(107), true);
  assert.equal(reservations.reserve('abc'), null);
  assert.equal(reservations.size, 0);
});

test('isVmidTakenError recognizes Proxmox collision messages', () => {
  const collisions = [
    'Proxmox POST /nodes/pve/qemu → 500: unable to create VM 105 - config file already exists',
    'VM 105 already exists',
    'CT 105 already exists on node pve',
    'unable to create VM 110 - VM already exists',
  ];
  for (const msg of collisions) {
    assert.equal(isVmidTakenError(msg), true, msg);
    assert.equal(isVmidTakenError(new Error(msg)), true, `Error(${msg})`);
  }
});

test('isVmidTakenError does not fire on unrelated failures', () => {
  const others = [
    'Proxmox request timeout',
    'storage \'local-lvm\' does not exist',
    'Cannot allocate a globally unique VMID while these Proxmox hosts are unreachable: pve1',
    '500 no such user',
    '',
  ];
  for (const msg of others) {
    assert.equal(isVmidTakenError(msg), false, msg);
  }
  assert.equal(isVmidTakenError(null), false);
  assert.equal(isVmidTakenError(undefined), false);
});
