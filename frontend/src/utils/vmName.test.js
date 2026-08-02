// Regression coverage for the frontend copy of the Proxmox VM-name sanitizer.
// The provisioning forms preview the name the backend will actually create, so
// the two copies must not drift: every case below is asserted against BOTH the
// frontend module and the backend original.
// Run with:  node --test src/utils/vmName.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { toPveVmName, PVE_VM_NAME_MAX } from './vmName.js';
// Reaching across into backend/ is deliberate: it is the only way to prove the
// preview matches the server. Both packages are ESM and vmName.js has no
// imports of its own, so this resolves as a plain file.
import {
  toPveVmName as backendToPveVmName,
  PVE_VM_NAME_MAX as BACKEND_MAX,
} from '../../../backend/src/utils/vmName.js';

// [input, expected] — mirrors backend/src/utils/vmName.test.js.
const CASES = [
  // mixed case / whitespace
  ['My Test VM', 'my-test-vm'],
  ['WEB01', 'web01'],
  ['  spaced   out  ', 'spaced-out'],
  // underscores and dots — the input /api/provision/create used to let through
  ['my_test_vm', 'my-test-vm'],
  ['my.test.vm', 'my-test-vm'],
  ['my_test.vm 01', 'my-test-vm-01'],
  // leading/trailing hyphens and dots
  ['-my-vm-', 'my-vm'],
  ['.my-vm.', 'my-vm'],
  ['---my-vm---', 'my-vm'],
  ['..-. my vm .-..', 'my-vm'],
  ['my   ___...   vm', 'my-vm'],
  // already valid — unchanged
  ['my-test-vm', 'my-test-vm'],
  ['web01', 'web01'],
  ['a', 'a'],
  ['a-b-c-1-2-3', 'a-b-c-1-2-3'],
  ['0', '0'],
  ['x'.repeat(63), 'x'.repeat(63)],
  // length clamp, including the truncate-onto-a-hyphen case
  ['a'.repeat(200), 'a'.repeat(63)],
  [`${'a'.repeat(62)}-b`, 'a'.repeat(62)],
  [`${'a'.repeat(60)}---${'b'.repeat(10)}`, 'a'.repeat(60)],
  // nothing usable left
  ['', null],
  ['---', null],
  ['...', null],
  ['!!!', null],
  ['   ', null],
  ['@#$%^&*()', null],
  ['_', null],
  // unicode / emoji
  ['Bücher', 'b-cher'],
  ['café', 'caf'],
  ['vm 🚀 one', 'vm-one'],
  ['🚀', null],
  ['сервер', null],
  ['🚀 rocket 🚀', 'rocket'],
  // metacharacters
  ['../../etc/passwd', 'etc-passwd'],
  ['vm,bridge=vmbr0,tag=99', 'vm-bridge-vmbr0-tag-99'],
  ['vm; rm -rf /', 'vm-rm--rf'],
];

const NON_STRINGS = [null, undefined, 0, 123, true, false, NaN, {}, [], ['a'], () => {}];

test('the frontend copy produces the documented output', () => {
  for (const [input, expected] of CASES) {
    assert.equal(toPveVmName(input), expected, `for ${JSON.stringify(input)}`);
  }
});

test('non-string input yields null', () => {
  for (const v of NON_STRINGS) {
    assert.equal(toPveVmName(v), null, `expected null for ${String(v)}`);
  }
});

test('the frontend copy agrees with backend/src/utils/vmName.js on every case', () => {
  assert.equal(PVE_VM_NAME_MAX, BACKEND_MAX);
  for (const [input] of CASES) {
    assert.equal(
      toPveVmName(input),
      backendToPveVmName(input),
      `preview drifted from the backend for ${JSON.stringify(input)}`
    );
  }
  for (const v of NON_STRINGS) {
    assert.equal(toPveVmName(v), backendToPveVmName(v), `preview drifted for ${String(v)}`);
  }
});

test('the two copies agree on random junk as well', () => {
  const alphabet = ' aA0-_.éü🚀/,=:;!';
  let seed = 1337;
  const rnd = () => {
    // xorshift — deterministic so a failure is reproducible.
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rnd() * 80);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    assert.equal(toPveVmName(s), backendToPveVmName(s), `drifted for ${JSON.stringify(s)}`);
  }
});
