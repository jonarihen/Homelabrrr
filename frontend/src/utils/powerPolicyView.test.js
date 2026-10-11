import test from 'node:test';
import assert from 'node:assert/strict';
import { controlStatusLines, modeLabel, outcomeLabel, policyRequest } from './powerPolicyView.js';

const draft = () => ({
  version: 3, automationEnabled: true, extra: 'ignored',
  schedule: { enabled: true, timezone: 'Europe/Copenhagen', defaultMode: 'low', version: 9,
    windows: [{ days: 62, start: '16:00', end: '02:00', mode: 'high', id: 'x' }] },
  pricePolicy: { enabled: true, basis: 'variable_retail_including_vat', contractRef: '4', area: 'DK2', priceOnlyDefault: '',
    minAutomaticUpshiftMinutes: 5, version: 7,
    expensive: { enabled: true, threshold: '3,00', hysteresis: '0,10', capMode: 'dynamic' },
    cheap: { enabled: false, threshold: '', hysteresis: '' } },
});

test('policy request is allowlisted, keeps Danish input and never invents a price-only default', () => {
  const request = policyRequest(draft());
  assert.equal(request.extra, undefined);
  assert.equal(request.schedule.version, undefined, 'revisions are server-owned');
  assert.equal(request.pricePolicy.version, undefined);
  assert.deepEqual(request.schedule.windows, [{ days: 62, start: '16:00', end: '02:00', mode: 'high' }]);
  assert.equal(request.pricePolicy.expensive.threshold, '3,00');
  assert.equal('priceOnlyDefault' in request.pricePolicy, false);
  const chosen = draft(); chosen.pricePolicy.priceOnlyDefault = 'dynamic';
  assert.equal(policyRequest(chosen).pricePolicy.priceOnlyDefault, 'dynamic');
});

test('status lines separate drift hold, pending verification, backoff and errors', () => {
  const now = Date.parse('2026-10-12T16:00:00Z');
  const lines = controlStatusLines({ driftHold: true, driftHoldUntil: null, pendingTarget: 'high', failureCount: 2,
    nextAttemptAt: '2026-10-12T16:02:00Z', lastError: 'read_failed', actionInFlight: false }, now);
  assert.equal(lines.length, 4);
  assert.match(lines[0].text, /until you resume/);
  assert.match(lines[1].text, /unverified/);
  assert.match(lines[2].text, /2 consecutive/);
  assert.equal(controlStatusLines({ nextAttemptAt: '2026-10-12T15:00:00Z' }, now).length, 0);
});

test('labels', () => {
  assert.equal(modeLabel('dynamic'), 'Dynamic / Balanced');
  assert.equal(outcomeLabel('external_drift:low'), 'External change to Static Low Power');
  assert.equal(outcomeLabel(null), 'None yet');
});
