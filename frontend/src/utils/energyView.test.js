import test from 'node:test';
import assert from 'node:assert/strict';
import { dkk, fundingProgress, shiftMonth, currentMonth, wattPath, historyPath } from './energyView.js';

test('money and progress preserve unknowns and avoid misleading percentages', () => {
  assert.equal(dkk(null), 'Unknown');
  assert.equal(dkk('12345'), dkk(12345), 'PostgreSQL decimal strings display as currency');
  assert.equal(dkk('-250'), dkk(-250));
  assert.equal(dkk('12.5'), 'Unknown');
  assert.equal(dkk('9007199254740993'), 'Unknown');
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

import { basisLabel, costStatusLabel, decisionText, fundingStatusLabel, markerPositions, progressView, reasonText } from './energyView.js';

test('decision text explains the resolved mode and reason in plain words', () => {
  assert.equal(decisionText({ mode: 'dynamic', reason: 'price_high', validUntil: '2026-10-08T12:15:00Z' }), 'Dynamic: price exceeds the expensive-price limit until 14:15');
  assert.equal(decisionText({ mode: 'high', reason: 'price_low' }), 'High: cheap-price boost');
  assert.equal(decisionText({ mode: 'low', reason: 'schedule', validUntil: '2026-10-08T12:15:00Z' }), 'Low: weekly schedule');
  assert.equal(decisionText({ mode: null, reason: 'paused' }), 'No mode selected: automation paused');
  assert.equal(reasonText('drift_hold'), 'held after an external change');
  assert.equal(reasonText('something_new'), 'something new');
});
test('basis and status labels are readable and never blank', () => {
  assert.match(basisLabel('variable_retail_including_vat'), /VAT/);
  assert.match(basisLabel('spot_only_excluding_retail_additions'), /Spot price only/);
  assert.equal(basisLabel(null), 'Price basis not configured');
  assert.equal(costStatusLabel('finalized_partial'), 'Finalized, partial coverage');
  assert.equal(fundingStatusLabel('recalculation_pending'), 'Recalculation pending');
  assert.equal(costStatusLabel(undefined), 'Unavailable');
});
test('progress uses only the server percentage and rejects impossible values', () => {
  assert.equal(progressView(null), null);
  assert.equal(progressView({ percent: null, basis: 'finalized_lab_cost' }), null);
  assert.equal(progressView({ percent: Number.NaN }), null);
  assert.equal(progressView({ percent: 140 }), null);
  assert.deepEqual(progressView({ percent: 9.6, basis: 'finalized_lab_cost' }), { percent: 9.6, basis: 'finalized lab cost', estimate: false });
  assert.equal(progressView({ percent: 20, basis: 'current_estimate' }).estimate, true);
});
test('mode markers stay inside the chart range', () => {
  const markers = markerPositions([{ at: '2026-10-08T11:00:00Z' }, { at: '2026-10-07T00:00:00Z' }, { at: 'bad' }], '2026-10-08T10:00:00Z', '2026-10-08T12:00:00Z');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].x, 300);
});
