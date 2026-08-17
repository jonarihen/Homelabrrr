import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD_MIN_LENGTH, validateHost, validateHttpUrl, validateIp, validateObject,
  validatePassword, validatePort, validateUsername, validateVlanTag, validateVmid,
} from './validation.ts';

test('ports reject coercion and out-of-range values', () => {
  assert.equal(validatePort('22'), 22);
  assert.throws(() => validatePort('22x'));
  assert.throws(() => validatePort(0));
  assert.throws(() => validatePort(65536));
});

test('shared identifiers, IPs, VLANs, and URLs reject coercion and unsafe forms', () => {
  assert.equal(validateVmid('100'), 100);
  assert.throws(() => validateVmid('100x'));
  assert.equal(validateVlanTag(4094), 4094);
  assert.throws(() => validateVlanTag(4095));
  assert.equal(validateIp('2001:db8::1'), '2001:db8::1');
  assert.throws(() => validateIp('999.1.1.1'));
  assert.equal(validateHttpUrl('https://example.com/path'), 'https://example.com/path');
  assert.throws(() => validateHttpUrl('https://user:pass@example.com'));
});

test('body schemas reject arrays, missing fields, and unexpected input', () => {
  assert.deepEqual(validateObject({ username: 'alice' }, { fields: ['username'], required: ['username'] }), { username: 'alice' });
  assert.throws(() => validateObject([], { fields: [] }));
  assert.throws(() => validateObject({}, { fields: ['username'], required: ['username'] }));
  assert.throws(() => validateObject({ username: 'alice', admin: true }, { fields: ['username'] }));
});

test('one password policy is reusable by every account path', () => {
  assert.throws(() => validatePassword('x'.repeat(PASSWORD_MIN_LENGTH - 1)));
  assert.equal(validatePassword('x'.repeat(PASSWORD_MIN_LENGTH)).length, PASSWORD_MIN_LENGTH);
});

test('usernames and hosts are bounded and normalized', () => {
  assert.equal(validateUsername(' jane.doe '), 'jane.doe');
  assert.throws(() => validateUsername('../admin'));
  assert.equal(validateHost('VM-01.Example.COM'), 'vm-01.example.com');
  assert.throws(() => validateHost('https://example.com'));
});
