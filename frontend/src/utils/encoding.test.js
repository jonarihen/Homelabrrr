import test from 'node:test';
import assert from 'node:assert/strict';
import { stringToBase64Utf8 } from './encoding.js';

test('encodes plain ASCII', () => {
  const input = 'ls -la\n';
  const encoded = stringToBase64Utf8(input);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), input);
});

test('encodes accented Latin characters', () => {
  const inputs = ['café', 'naïve', 'münchen'];
  for (const input of inputs) {
    const encoded = stringToBase64Utf8(input);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), input);
  }
});

test('encodes CJK and Cyrillic characters', () => {
  const inputs = ['日本語', 'Привет'];
  for (const input of inputs) {
    const encoded = stringToBase64Utf8(input);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), input);
  }
});

test('encodes emojis', () => {
  const inputs = ['🚀', '🙂'];
  for (const input of inputs) {
    const encoded = stringToBase64Utf8(input);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), input);
  }
});

test('handles empty and nullish input', () => {
  assert.equal(stringToBase64Utf8(''), '');
  assert.equal(stringToBase64Utf8(null), '');
  assert.equal(stringToBase64Utf8(undefined), '');
});

test('handles large strings exceeding chunk size', () => {
  const input = '🚀 日本語 naïve '.repeat(2000);
  const encoded = stringToBase64Utf8(input);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), input);
});
