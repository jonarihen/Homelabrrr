import test from 'node:test';
import assert from 'node:assert/strict';
import { dkk, fundingProgress, shiftMonth, currentMonth, wattPath, historyPath } from './energyView.js';

test('money and progress preserve unknowns and avoid misleading percentages', () => {
  assert.equal(dkk(null), 'Unknown');
  assert.equal(fundingProgress(null, 9600), null);
  assert.equal(fundingProgress(0, 9600), null);
  assert.equal(fundingProgress(100_000, 9600), 9.6);
  assert.equal(fundingProgress(100_000, 120_000), 100);
});
test('month controls use calendar months across year and Copenhagen midnight', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(currentMonth(new Date('2026-10-31T23:30:00Z')), '2026-11');
});
test('history omits a chart when there is no measured trend', () => {
  assert.equal(wattPath([{ watts: null }]), '');
  assert.match(wattPath([{ watts: 100 }, { watts: 200 }]), /^M/);
});
test('time-based energy trend leaves gaps rather than connecting missing coverage', () => {
  const points = [
    { at: '2026-10-08T10:00:00Z', kwh: 0.1 },
    { at: '2026-10-08T11:00:00Z', kwh: 0.2 },
    { at: '2026-10-08T14:00:00Z', kwh: 0.3 },
  ];
  const path = historyPath(points, 'kwh', '2026-10-08T10:00:00Z', '2026-10-08T15:00:00Z', 3600);
  assert.match(path, /^M/);
  assert.equal((path.match(/M/g) || []).length, 2);
  assert.equal((path.match(/L/g) || []).length, 1);
});
