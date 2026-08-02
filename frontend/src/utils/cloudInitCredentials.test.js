// Coverage for the deploy form's cloud-init credential guards. These must agree
// with backend/src/utils/cloudInitCredentials.test.js — the client blocks submit
// on exactly what the API refuses.
// Run with:  node --test src/utils/cloudInitCredentials.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsableKey, unusableKeyReason, cloudInitLoginMissing, NO_LOGIN_MESSAGE, NO_PUBLIC_KEY_LABEL,
} from './cloudInitCredentials.js';

const LAPTOP = { id: 1, name: 'laptop', public_key: 'ssh-ed25519 AAAAC3Nza laptop', encrypted: false };
const DESKTOP = { id: 2, name: 'desktop', public_key: 'ssh-rsa AAAAB3Nza desktop', encrypted: false };
const LOCKED = { id: 3, name: 'locked', public_key: '', encrypted: true };
const BLANK = { id: 4, name: 'blank', public_key: '   \n ', encrypted: false };

test('a key is usable only with a non-blank public key', () => {
  assert.equal(isUsableKey(LAPTOP), true);
  assert.equal(isUsableKey(LOCKED), false);
  assert.equal(isUsableKey(BLANK), false, 'whitespace-only is not a public key');
  assert.equal(isUsableKey({ id: 5, name: 'null', public_key: null }), false);
  assert.equal(isUsableKey(undefined), false);
});

test('an unusable key explains itself; a usable one says nothing', () => {
  assert.equal(unusableKeyReason(LAPTOP), '');
  assert.match(unusableKeyReason(LOCKED), /passphrase/);
  assert.match(unusableKeyReason(BLANK), /\.pub/);
  // The headline is separate so the badge and the picker can compose it once.
  assert.equal(NO_PUBLIC_KEY_LABEL, 'No public key');
});

test('a password alone is enough to deploy', () => {
  assert.equal(cloudInitLoginMissing({ password: 'hunter2hunter2', keyIds: [], keys: [] }), false);
});

test('a usable key alone is enough to deploy', () => {
  assert.equal(cloudInitLoginMissing({ password: '', keyIds: [1], keys: [LAPTOP, LOCKED] }), false);
  assert.equal(cloudInitLoginMissing({ password: '', keyIds: [2, 3], keys: [LAPTOP, DESKTOP, LOCKED] }), false);
});

test('neither a password nor a key blocks the deploy', () => {
  assert.equal(cloudInitLoginMissing({ password: '', keyIds: [], keys: [LAPTOP] }), true);
  assert.equal(cloudInitLoginMissing({ password: undefined, keyIds: undefined, keys: undefined }), true);
});

test('the bug: selecting only keys that cannot be installed is not a login', () => {
  assert.equal(cloudInitLoginMissing({ password: '', keyIds: [3, 4], keys: [LAPTOP, LOCKED, BLANK] }), true);
});

test('a selected id with no matching key does not count as a login', () => {
  assert.equal(cloudInitLoginMissing({ password: '', keyIds: [99], keys: [LAPTOP] }), true);
});

test('the blocking message matches the backend wording', () => {
  assert.equal(
    NO_LOGIN_MESSAGE,
    'This VM would have no way to log in. Set a cloud-init password, choose an SSH key, or both.',
  );
});
