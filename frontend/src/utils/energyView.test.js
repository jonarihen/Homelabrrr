import test from 'node:test';
import assert from 'node:assert/strict';
import { dkk, fundingProgress, shiftMonth, currentMonth, wattPath } from './energyView.js';

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
