import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedDrain } from './shutdown.ts';

test('bounded drain reports normal completion', async () => {
  const result = await boundedDrain([Promise.resolve('done'), Promise.reject(new Error('recorded'))], 100);
  assert.equal(result.status, 'drained');
  assert.equal(result.results[0].status, 'fulfilled');
  assert.equal(result.results[1].status, 'rejected');
});

test('bounded drain returns at the forced timeout', async () => {
  const never = new Promise(() => {});
  const result = await boundedDrain([never], 10);
  assert.equal(result.status, 'timeout');
});
