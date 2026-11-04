import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeNodeRef, decodeNodeRef, displayNode, routeNode, vmIdentityKey } from './nodeRef.js';
import * as backend from '../../../backend/src/utils/nodeRef.ts';

test('frontend and backend nodeRef agree (copies must not drift)', () => {
  for (const v of ['', null, undefined, 'pve1', '3~pve1', '~pve1', 'abc~x', '1~', '2~a~b', ' 4~n ', '-1~x']) {
    assert.deepEqual(decodeNodeRef(v), backend.decodeNodeRef(v), String(v));
  }
  for (const [h, n] of [[1, 'a'], ['2', 'b'], [0, 'c'], [null, 'd'], [1, ''], [1, ' e ']]) {
    assert.equal(encodeNodeRef(h, n), backend.encodeNodeRef(h, n));
  }
});

test('display/route helpers handle encoded, bare and object inputs', () => {
  assert.equal(displayNode('3~pve1'), 'pve1');
  assert.equal(displayNode('pve1'), 'pve1');
  assert.equal(displayNode(''), '');
  assert.equal(routeNode('3~pve1'), '3~pve1');
  assert.equal(routeNode({ nodeRef: '3~pve1', node: 'pve1' }), '3~pve1');
  assert.equal(routeNode({ node: 'pve1' }), 'pve1');
  assert.equal(routeNode(null), '');
  assert.equal(vmIdentityKey({ nodeRef: '3~pve1', vmid: 100 }), '3~pve1-100');
  assert.equal(vmIdentityKey(null), '-');
});
