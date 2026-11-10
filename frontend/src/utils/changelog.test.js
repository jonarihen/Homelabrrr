import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inlineTokens, parseChangelog } from './changelog.js';

const text = (value) => ({ type: 'text', text: value });
// Text outside code spans; inside backticks asterisks are meant literally.
const prose = (tokens) => tokens.map((token) => token.children ? prose(token.children) : token.type === 'code' ? '' : token.text).join('');

test('bold, emphasis and code become tokens around plain text', () => {
  assert.deepEqual(inlineTokens('**Payment methods.** One switch for `PayPal`, *really*.'), [
    { type: 'bold', children: [text('Payment methods.')] }, text(' One switch for '),
    { type: 'code', text: 'PayPal' }, text(', '), { type: 'em', children: [text('really')] }, text('.'),
  ]);
});

test('markup nests inside bold, and asterisks inside code stay literal', () => {
  assert.deepEqual(inlineTokens('**Run `npm test` now**'), [{ type: 'bold', children: [text('Run '), { type: 'code', text: 'npm test' }, text(' now')] }]);
  assert.deepEqual(inlineTokens('use `a ** b` and `*.js`'), [text('use '), { type: 'code', text: 'a ** b' }, text(' and '), { type: 'code', text: '*.js' }]);
});

test('plain text and stray asterisks pass through unchanged', () => {
  assert.deepEqual(inlineTokens('nothing special'), [text('nothing special')]);
  assert.deepEqual(inlineTokens('2 * 3 * 4 and a lone ** here'), [text('2 * 3 * 4 and a lone ** here')]);
  assert.deepEqual(inlineTokens(''), []);
});

test('no bold markers are left in the prose of any real changelog entry', () => {
  const entries = parseChangelog(readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    for (const item of [entry.summary, ...entry.sections.flatMap((section) => section.items)]) {
      assert.ok(!prose(inlineTokens(item)).includes('**'), `${entry.date}: ${item.slice(0, 80)}`);
    }
  }
});
