import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCloneName } from './roleClone.js';

test('an unused name gets the plain (copy) suffix', () => {
  assert.equal(defaultCloneName('operators', []), 'operators (copy)');
  assert.equal(defaultCloneName('operators', ['operators']), 'operators (copy)');
});

test('a taken (copy) steps on to the next free number', () => {
  assert.equal(
    defaultCloneName('operators', ['operators', 'operators (copy)']),
    'operators (copy 2)',
  );
  assert.equal(
    defaultCloneName('operators', ['operators (copy)', 'operators (copy 2)']),
    'operators (copy 3)',
  );
});

test('it skips a gap rather than reusing a taken number', () => {
  assert.equal(
    defaultCloneName('operators', ['operators (copy)', 'operators (copy 2)', 'operators (copy 4)']),
    'operators (copy 3)',
  );
});

test('cloning a clone nests rather than renumbering the original', () => {
  assert.equal(
    defaultCloneName('operators (copy)', ['operators', 'operators (copy)']),
    'operators (copy) (copy)',
  );
});

test('the existing-name list is optional', () => {
  assert.equal(defaultCloneName('operators'), 'operators (copy)');
});
