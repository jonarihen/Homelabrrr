// Regression coverage for the FortiGate VIP-name shortener.
// Run with:  node --test src/utils/vipName.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shortenVipName,
  vipNameHash,
  VIP_NAME_MAX,
  PORT_FORWARD_NAME_MAX,
  PORT_FORWARD_POLICY_PREFIX,
} from './vipName.ts';

const M = PORT_FORWARD_NAME_MAX;

test('limits leave room for the "PF: " policy prefix', () => {
  assert.equal(VIP_NAME_MAX, 35);
  assert.equal(PORT_FORWARD_NAME_MAX + PORT_FORWARD_POLICY_PREFIX.length, VIP_NAME_MAX);
});

test('short names pass through unchanged', () => {
  for (const name of ['web01 - SSH', 'app - HTTPS', 'db - Custom 5432/tcp', '']) {
    assert.equal(shortenVipName(name, M), name.trim());
    assert.ok(!shortenVipName(name, M).includes('~'));
  }
});

test('a name exactly at the limit is untouched; one over is shortened', () => {
  const exact = 'a-fairly-long-service-name-here'; // 31 chars
  assert.equal(exact.length, M);
  assert.equal(shortenVipName(exact, M), exact);

  const over = exact + 'e'; // 32 chars
  const out = shortenVipName(over, M);
  assert.notEqual(out, over);
  assert.ok(out.length <= M);
  assert.ok(out.includes('~'));
});

test('long names never exceed the limit and the policy name still fits 35', () => {
  const samples = [
    'minecraft-fi-lille-ven - Custom 25565/tcp',
    'some-really-really-long-machine-name - HTTPS',
    'x'.repeat(200),
    'no-separator-here-just-a-very-long-single-token-name',
  ];
  for (const name of samples) {
    const out = shortenVipName(name, M);
    assert.ok(out.length <= M, `${name} -> ${out} (${out.length})`);
    assert.ok((PORT_FORWARD_POLICY_PREFIX + out).length <= VIP_NAME_MAX);
    assert.ok(out.includes('~'));
  }
});

test('custom port/protocol suffix stays visible where space permits', () => {
  const out = shortenVipName('minecraft-fi-lille-ven - Custom 25565/tcp', M);
  assert.equal(out, 'minecra~xv5s - Custom 25565/tcp');
  assert.ok(out.endsWith(' - Custom 25565/tcp'));
  assert.ok(out.length <= M);
});

test('names sharing a truncated prefix get distinct collision-resistant suffixes', () => {
  const a = 'minecraft-fi-lille-venstre - Custom 25565/tcp';
  const b = 'minecraft-fi-lille-vendetta - Custom 25565/tcp';
  const outA = shortenVipName(a, M);
  const outB = shortenVipName(b, M);
  // Same visible head + tail...
  assert.ok(outA.startsWith('minecra~'));
  assert.ok(outB.startsWith('minecra~'));
  assert.ok(outA.endsWith(' - Custom 25565/tcp'));
  assert.ok(outB.endsWith(' - Custom 25565/tcp'));
  // ...but the hash keeps them distinct.
  assert.notEqual(outA, outB);
});

test('shortening is idempotent and stable', () => {
  const name = 'minecraft-fi-lille-ven - Custom 25565/tcp';
  const once = shortenVipName(name, M);
  assert.equal(shortenVipName(once, M), once);
});

test('hash is deterministic, fixed-width base36, and pinned', () => {
  assert.match(vipNameHash('anything at all'), /^[0-9a-z]{4}$/);
  assert.equal(vipNameHash('abc'), vipNameHash('abc'));
  // Pinned so the frontend copy can be checked against these exact values.
  assert.equal(vipNameHash('abc'), 'igaz');
  assert.equal(vipNameHash('web01 - SSH'), 'sb6n');
});
