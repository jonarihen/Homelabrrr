import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNodeRef, encodeNodeRef, nodeLookupCandidates, isValidNodeName } from './nodeRef.ts';

test('encode/decode round-trips host-encoded refs', () => {
  const ref = encodeNodeRef(3, 'pve-a');
  assert.equal(ref, '3~pve-a');
  assert.deepEqual(decodeNodeRef(ref), { hostId: 3, nodeName: 'pve-a', nodeRef: '3~pve-a' });
  assert.equal(encodeNodeRef('7', 'n1'), '7~n1');
});

test('encodeNodeRef falls back to the bare name without a usable host id', () => {
  for (const h of [0, -1, null, undefined, 'abc', NaN]) assert.equal(encodeNodeRef(h, 'pve1'), 'pve1');
  assert.equal(encodeNodeRef(1, ''), '');
  assert.equal(encodeNodeRef(1, '   '), '');
  assert.equal(encodeNodeRef(1, null), '');
  assert.equal(encodeNodeRef(1, '  pve1 '), '1~pve1');
});

test('decodeNodeRef treats bare and malformed values as bare names', () => {
  const bare = (v: string, name = v) => assert.deepEqual(decodeNodeRef(v), { hostId: null, nodeName: name, nodeRef: name });
  bare('pve1');
  bare('~pve1');     // empty host part
  bare('abc~pve1');  // non-numeric host
  bare('1~');        // empty node
  bare('-1~pve1');   // sign is not a digit
  bare(' pve1 ', 'pve1');
  assert.deepEqual(decodeNodeRef(''), { hostId: null, nodeName: '', nodeRef: '' });
  assert.deepEqual(decodeNodeRef(null), { hostId: null, nodeName: '', nodeRef: '' });
  assert.deepEqual(decodeNodeRef(undefined), { hostId: null, nodeName: '', nodeRef: '' });
});

test('decodeNodeRef splits on the first separator only', () => {
  assert.deepEqual(decodeNodeRef('2~a~b'), { hostId: 2, nodeName: 'a~b', nodeRef: '2~a~b' });
});

test('nodeLookupCandidates: encoded tries ref then bare; bare tries bare only', () => {
  assert.deepEqual(nodeLookupCandidates('2~pve2'), ['2~pve2', 'pve2']);
  assert.deepEqual(nodeLookupCandidates('pve1'), ['pve1']);
  assert.deepEqual(nodeLookupCandidates('abc~pve1'), ['abc~pve1']);
  assert.deepEqual(nodeLookupCandidates(''), []);
  assert.deepEqual(nodeLookupCandidates(undefined), []);
});

test('isValidNodeName rejects path-steering characters and dot-only names', () => {
  assert.equal(isValidNodeName('pve-1.lab_x'), true);
  for (const bad of ['', '.', '..', 'a/b', 'a?b', 'a#b', 'a b', '1~pve', '../etc']) assert.equal(isValidNodeName(bad), false, bad);
});
