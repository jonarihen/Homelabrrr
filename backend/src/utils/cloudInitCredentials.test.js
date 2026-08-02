// Regression coverage for cloud-init login credentials: selected SSH keys must
// never be silently dropped, and a cloud-init deploy must not produce a VM with
// no way to log in.
// Run with:  node --test src/utils/cloudInitCredentials.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsableKeyRow, resolveSshKeys, unusableKeysError, assertLoginPossible, NO_LOGIN_MESSAGE,
} from './cloudInitCredentials.js';

const key = (id, name, publicKey) => ({ id, name, public_key: publicKey });
const LAPTOP = key(1, 'laptop', 'ssh-ed25519 AAAAC3Nza laptop');
const DESKTOP = key(2, 'desktop', 'ssh-rsa AAAAB3Nza desktop');

test('isUsableKeyRow requires a non-blank stored public key', () => {
  assert.equal(isUsableKeyRow(LAPTOP), true);
  assert.equal(isUsableKeyRow(key(3, 'x', '')), false);
  assert.equal(isUsableKeyRow(key(3, 'x', '   \n\t ')), false);
  assert.equal(isUsableKeyRow(key(3, 'x', null)), false);
  assert.equal(isUsableKeyRow(undefined), false);
});

test('all requested keys usable — every public key is returned, in order', () => {
  const { keys, unusable } = resolveSshKeys([1, 2], [LAPTOP, DESKTOP]);
  assert.deepEqual(keys, [LAPTOP.public_key, DESKTOP.public_key]);
  assert.deepEqual(unusable, []);
});

test('string ids from a JSON body resolve the same as numbers', () => {
  const { keys, unusable } = resolveSshKeys(['1', '2'], [LAPTOP, DESKTOP]);
  assert.deepEqual(keys, [LAPTOP.public_key, DESKTOP.public_key]);
  assert.deepEqual(unusable, []);
});

test('a key with an empty public_key is reported, not dropped', () => {
  const encrypted = key(3, 'encrypted-laptop', '');
  const { keys, unusable } = resolveSshKeys([1, 3], [LAPTOP, encrypted]);
  assert.deepEqual(keys, [LAPTOP.public_key]);
  assert.deepEqual(unusable, [{ id: 3, name: 'encrypted-laptop', reason: 'no-public-key' }]);
});

test('a whitespace-only public key counts as no public key', () => {
  const blank = key(4, 'blank', '   \n  ');
  const { keys, unusable } = resolveSshKeys([4], [blank]);
  assert.deepEqual(keys, []);
  assert.deepEqual(unusable, [{ id: 4, name: 'blank', reason: 'no-public-key' }]);
});

test('the bug: every requested key unusable yields zero keys AND a report', () => {
  const rows = [key(5, 'a', ''), key(6, 'b', '')];
  const { keys, unusable } = resolveSshKeys([5, 6], rows);
  assert.deepEqual(keys, []);
  assert.equal(unusable.length, 2, 'the caller must be able to tell this apart from "no keys selected"');
  const message = unusableKeysError(unusable);
  assert.match(message, /'a'/);
  assert.match(message, /'b'/);
  assert.match(message, /no public key stored/);
});

test('an id that does not belong to the user is reported as missing', () => {
  // The caller scopes the query with `WHERE user_id = ?`, so someone else's key
  // simply produces no row — it must not pass as "nothing selected".
  const { keys, unusable } = resolveSshKeys([1, 99], [LAPTOP]);
  assert.deepEqual(keys, [LAPTOP.public_key]);
  assert.deepEqual(unusable, [{ id: 99, name: '', reason: 'missing' }]);
  assert.match(unusableKeysError(unusable), /#99 was not found/);
});

test('malformed ids are reported rather than reaching the DB as NaN', () => {
  const { keys, unusable } = resolveSshKeys(['not-a-number'], [LAPTOP]);
  assert.deepEqual(keys, []);
  assert.equal(unusable.length, 1);
  assert.equal(unusable[0].reason, 'missing');
});

test('duplicate ids install the key once', () => {
  const { keys, unusable } = resolveSshKeys([1, 1, '1'], [LAPTOP]);
  assert.deepEqual(keys, [LAPTOP.public_key]);
  assert.deepEqual(unusable, []);
});

test('no keys requested is not an error', () => {
  for (const requested of [[], null, undefined, 'nonsense']) {
    const { keys, unusable } = resolveSshKeys(requested, [LAPTOP]);
    assert.deepEqual(keys, []);
    assert.deepEqual(unusable, []);
  }
});

test('unusableKeysError returns null when everything resolved', () => {
  assert.equal(unusableKeysError([]), null);
  assert.equal(unusableKeysError(undefined), null);
});

test('unusableKeysError names a single key the way the issue asks for', () => {
  const message = unusableKeysError([{ id: 1, name: 'laptop', reason: 'no-public-key' }]);
  assert.equal(
    message,
    "Selected SSH key 'laptop' has no public key stored, so it can't be installed on the VM. "
    + 'Re-add it with its .pub file (or its passphrase), or pick another key.',
  );
});

test('cloud-init deploy: a password alone is enough', () => {
  assert.doesNotThrow(() => assertLoginPossible({
    ciPassword: 'hunter2hunter2', sshKeys: [], cloudInitCapable: true,
  }));
});

test('cloud-init deploy: a key alone is enough (array or joined string)', () => {
  assert.doesNotThrow(() => assertLoginPossible({
    ciPassword: '', sshKeys: [LAPTOP.public_key], cloudInitCapable: true,
  }));
  assert.doesNotThrow(() => assertLoginPossible({
    ciPassword: undefined, sshKeys: `${LAPTOP.public_key}\n${DESKTOP.public_key}`, cloudInitCapable: true,
  }));
});

test('cloud-init deploy: neither a password nor a key is refused with 400', () => {
  for (const args of [
    { ciPassword: '', sshKeys: '', cloudInitCapable: true },
    { ciPassword: undefined, sshKeys: undefined, cloudInitCapable: true },
    { ciPassword: '', sshKeys: [], cloudInitCapable: true },
    { ciPassword: '', sshKeys: ['   '], cloudInitCapable: true },
  ]) {
    assert.throws(
      () => assertLoginPossible(args),
      (err) => err.status === 400 && err.message === NO_LOGIN_MESSAGE,
      `expected a refusal for ${JSON.stringify(args)}`,
    );
  }
});

test('a non-cloud-init deploy with no credentials is left alone', () => {
  // ISO / template installs run their own installer, which sets up the account.
  assert.doesNotThrow(() => assertLoginPossible({
    ciPassword: '', sshKeys: [], cloudInitCapable: false,
  }));
  assert.doesNotThrow(() => assertLoginPossible({ cloudInitCapable: undefined }));
});
