// Coverage for the websocket close-code filter that keeps a dropped Proxmox
// console from crashing the backend.
// Run with:  node --test src/utils/wsClose.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendableCloseCode } from './wsClose.ts';

test('the reserved codes a peer only ever reports are never sent on', () => {
  // These are exactly what `ws` hands the close handler when the other side
  // vanishes — and exactly what it throws on if you try to send them.
  for (const reserved of [1004, 1005, 1006, 1015, 1016, 999, 0, -1, 5000, 65535]) {
    assert.equal(sendableCloseCode(reserved), null, String(reserved));
  }
});

test('normal and application close codes pass through unchanged', () => {
  for (const ok of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]) {
    assert.equal(sendableCloseCode(ok), ok, String(ok));
  }
});

test('the private range is usable end to end', () => {
  assert.equal(sendableCloseCode(3000), 3000);
  assert.equal(sendableCloseCode(4999), 4999);
  assert.equal(sendableCloseCode(2999), null);
});

test('a missing or non-integer code degrades to no-status rather than throwing', () => {
  for (const bad of [undefined, null, '', 'going away', NaN, Infinity, 1000.5, {}, []]) {
    assert.equal(sendableCloseCode(bad), null, JSON.stringify(bad));
  }
  // A numeric string is still a usable code — `ws` would accept it too.
  assert.equal(sendableCloseCode('1000'), 1000);
});
