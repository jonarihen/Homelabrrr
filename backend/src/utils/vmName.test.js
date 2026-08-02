// Regression coverage for the Proxmox VM-name sanitizer.
// Run with:  node --test src/utils/vmName.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { toPveVmName, PVE_VM_NAME_MAX } from './vmName.js';

// Proxmox's own constraint, asserted against every non-null result below.
const PVE_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

test('the length cap is the DNS label limit', () => {
  assert.equal(PVE_VM_NAME_MAX, 63);
});

test('spaces and mixed case become a lowercase hyphenated label', () => {
  assert.equal(toPveVmName('My Test VM'), 'my-test-vm');
  assert.equal(toPveVmName('WEB01'), 'web01');
  assert.equal(toPveVmName('  spaced   out  '), 'spaced-out');
});

test('underscores become hyphens — the case that used to reach Proxmox', () => {
  // /api/provision/create validated `name` with the identifier pattern
  // [a-zA-Z0-9._-]+, so "my_test_vm" passed the portal and came back as a raw
  // 400 from the Proxmox API after a VMID had already been allocated.
  assert.equal(toPveVmName('my_test_vm'), 'my-test-vm');
  assert.equal(toPveVmName('my.test.vm'), 'my-test-vm');
  assert.equal(toPveVmName('my_test.vm 01'), 'my-test-vm-01');
});

test('leading and trailing hyphens and dots are stripped', () => {
  assert.equal(toPveVmName('-my-vm-'), 'my-vm');
  assert.equal(toPveVmName('.my-vm.'), 'my-vm');
  assert.equal(toPveVmName('---my-vm---'), 'my-vm');
  assert.equal(toPveVmName('..-. my vm .-..'), 'my-vm');
});

test('runs of separators collapse into a single hyphen', () => {
  assert.equal(toPveVmName('my   ___...   vm'), 'my-vm');
});

test('a name that is already valid passes through unchanged', () => {
  for (const name of ['my-test-vm', 'web01', 'a', 'a-b-c-1-2-3', '0', 'x'.repeat(63)]) {
    assert.equal(toPveVmName(name), name);
  }
});

test('a 64+ char name is truncated to 63 characters', () => {
  const long = 'a'.repeat(200);
  assert.equal(toPveVmName(long), 'a'.repeat(63));

  const sixtyFour = 'b'.repeat(64);
  assert.equal(toPveVmName(sixtyFour).length, 63);
});

test('truncation never leaves a trailing hyphen (the 63rd-char-is-"-" bug)', () => {
  // 64 chars whose 63rd character is a hyphen. The pre-fix /from-image
  // sanitizer stripped trailing hyphens *before* slicing, so the clamp
  // re-created one and Proxmox rejected the name anyway.
  const input = `${'a'.repeat(62)}-b`;
  assert.equal(input.length, 64);

  const buggy = input.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  assert.ok(buggy.endsWith('-'), 'precondition: the old pipeline emitted a trailing hyphen');

  const out = toPveVmName(input);
  assert.equal(out, 'a'.repeat(62));
  assert.ok(!out.endsWith('-'));
});

test('a run of hyphens straddling the cut is fully removed', () => {
  const out = toPveVmName(`${'a'.repeat(60)}---${'b'.repeat(10)}`);
  assert.equal(out, 'a'.repeat(60));
});

test('every non-null result satisfies the Proxmox name constraint', () => {
  const samples = [
    'My Test VM', 'my_test_vm', '-lead-', 'trail-', '.dots.', 'x'.repeat(500),
    `${'a'.repeat(62)}-b`, 'vm 🚀 one', 'Bücher 01', 'a b_c.d-e/f\\g:h', '  ', 'ünïcødé-vm',
    `${'a'.repeat(60)}---${'b'.repeat(10)}`,
  ];
  for (const s of samples) {
    const out = toPveVmName(s);
    if (out === null) continue;
    assert.ok(out.length <= PVE_VM_NAME_MAX, `${s} -> ${out} (${out.length})`);
    assert.match(out, PVE_NAME_RE, `${s} -> ${out}`);
  }
});

test('a name made entirely of punctuation yields null', () => {
  for (const s of ['---', '...', '!!!', '   ', '/', '@#$%^&*()', '_', '.-_.-_']) {
    assert.equal(toPveVmName(s), null, `expected null for ${JSON.stringify(s)}`);
  }
});

test('empty, null, undefined and non-string inputs yield null', () => {
  for (const v of ['', null, undefined, 0, 123, true, false, NaN, {}, [], ['a'], () => {}]) {
    assert.equal(toPveVmName(v), null, `expected null for ${String(v)}`);
  }
});

test('unicode and emoji are hyphenated, not smuggled through', () => {
  assert.equal(toPveVmName('Bücher'), 'b-cher');
  assert.equal(toPveVmName('café'), 'caf');
  assert.equal(toPveVmName('vm 🚀 one'), 'vm-one');
  assert.equal(toPveVmName('🚀'), null);
  assert.equal(toPveVmName('сервер'), null);   // no latin letters survive
  assert.equal(toPveVmName('🚀 rocket 🚀'), 'rocket');
});

test('path and shell metacharacters cannot survive into a property string', () => {
  assert.equal(toPveVmName('../../etc/passwd'), 'etc-passwd');
  assert.equal(toPveVmName('vm,bridge=vmbr0,tag=99'), 'vm-bridge-vmbr0-tag-99');
  // Interior double hyphens are legal for Proxmox, so a separator sitting next
  // to a literal hyphen is left alone rather than collapsed.
  assert.equal(toPveVmName('vm; rm -rf /'), 'vm-rm--rf');
});

test('sanitizing is idempotent', () => {
  const samples = ['My Test VM', 'my_test_vm', `${'a'.repeat(62)}-b`, 'x'.repeat(200), '-lead-'];
  for (const s of samples) {
    const once = toPveVmName(s);
    assert.equal(toPveVmName(once), once, `not idempotent for ${s}`);
  }
});
