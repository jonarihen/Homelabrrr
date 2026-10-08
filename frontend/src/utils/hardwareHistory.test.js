import test from 'node:test';
import assert from 'node:assert/strict';
import { hardwareWattPath } from './hardwareHistory.js';

const from = '2026-10-08T10:00:00Z';
const through = '2026-10-08T11:00:00Z';

test('hardware watts use observation time and split lines across missing bins', () => {
  const path = hardwareWattPath([
    { at: '2026-10-08T10:00:00Z', mean_watts: '250' },
    { at: '2026-10-08T10:03:00Z', mean_watts: '260' },
    { at: '2026-10-08T10:30:00Z', mean_watts: '270' },
    { at: '2026-10-08T10:33:00Z', mean_watts: '280' },
  ], from, through, 180);
  assert.equal((path.match(/M/g) || []).length, 2);
  assert.equal((path.match(/L/g) || []).length, 2);
});

test('missing and malformed watts never become a zero-power line', () => {
  assert.equal(hardwareWattPath([{ at: from, mean_watts: null }, { at: '2026-10-08T10:03:00Z', mean_watts: '' }], from, through, 180), '');
  assert.equal(hardwareWattPath([{ at: from, mean_watts: '0' }, { at: '2026-10-08T10:03:00Z', mean_watts: '0' }], from, through, 180).includes('L'), true);
});
