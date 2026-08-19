import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { generateTotpSecret, totpKeyUri, verifyTotp } from './totp.ts';

// A self-contained RFC 6238 code generator, so the tests assert against the
// spec rather than against the library under test agreeing with itself.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    bits += B32.indexOf(c).toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function totp(secretB32, epoch = Math.floor(Date.now() / 1000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epoch / 30)));
  const hmac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 1_000_000).padStart(6, '0');
}

// 10 bytes -> 16 base32 characters, exactly what otplib 12's generateSecret()
// produced and what every already-enrolled user has stored.
const LEGACY_SECRET = base32Encode(Buffer.from('0123456789'));

test('a secret enrolled under otplib 12 still verifies', () => {
  // otplib 13 enforces a 16-byte floor; unguarded it throws
  // "Secret must be at least 16 bytes (128 bits), got 10 bytes" and locks every
  // existing user out of sign-in.
  assert.equal(LEGACY_SECRET.length, 16);
  assert.equal(verifyTotp(totp(LEGACY_SECRET), LEGACY_SECRET), true);
});

test('a wrong code is rejected for both secret lengths', () => {
  // verifySync resolves to a `{ valid }` object, which is truthy even when the
  // code is wrong. Returning it raw would accept anything.
  const fresh = generateTotpSecret();
  for (const secret of [LEGACY_SECRET, fresh]) {
    assert.equal(verifyTotp('000000', secret), false);
    assert.equal(verifyTotp(totp(secret, Math.floor(Date.now() / 1000) - 600), secret), false);
  }
});

test('a missing or malformed code never passes', () => {
  const secret = generateTotpSecret();
  for (const bad of ['', null, undefined, '   ', 'abcdef', '12345', '1234567', {}, []]) {
    assert.equal(verifyTotp(bad, secret), false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(verifyTotp(totp(secret), ''), false);
  assert.equal(verifyTotp(totp(secret), null), false);
});

test('an unreadable secret fails the check instead of throwing', () => {
  // decryptSecret can hand back rubbish if the encryption key rotated badly —
  // that has to read as a failed code, not a 500 on the sign-in path.
  assert.equal(verifyTotp('123456', 'not-valid-base32-!!!'), false);
  assert.equal(verifyTotp('123456', 'A'), false);
});

test('codes issued to a fresh secret verify, and the secret is 20 bytes', () => {
  const secret = generateTotpSecret();
  assert.equal(secret.length, 32, 'expected 20 bytes as 32 base32 characters');
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.equal(verifyTotp(totp(secret), secret), true);
  // spaces are stripped the way authenticator apps display codes
  const code = totp(secret);
  assert.equal(verifyTotp(`${code.slice(0, 3)} ${code.slice(3)}`, secret), true);
});

test('two generated secrets differ', () => {
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});

test('the enrollment URI carries the secret and issuer', () => {
  const secret = generateTotpSecret();
  const uri = totpKeyUri('alice', secret);
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.ok(uri.includes(`secret=${secret}`), uri);
  assert.ok(uri.includes('issuer=VM%20Manager'), uri);
  assert.ok(uri.includes('alice'), uri);
});
