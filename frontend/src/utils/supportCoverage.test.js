import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageOverview } from './supportCoverage.js';

const month = (overrides) => ({ month: '2026-10', open: false, kwh: 100, costOre: 40000, knownNetOre: 0, ...overrides });

test('support below cost leaves the remainder with the owner', () => {
  const view = coverageOverview([month({ knownNetOre: 10000 })]);
  assert.equal(view.costOre, 40000);
  assert.equal(view.supportOre, 10000);
  assert.equal(view.coveredOre, 10000);
  assert.equal(view.ownerOre, 30000);
  assert.equal(view.creditOre, 0);
  assert.equal(view.percent, 25);
});

test('support above cost caps coverage at 100% and reports the credit', () => {
  const view = coverageOverview([month({ knownNetOre: 50000 })]);
  assert.equal(view.coveredOre, 40000);
  assert.equal(view.ownerOre, 0);
  assert.equal(view.creditOre, 10000);
  assert.equal(view.percent, 100);
});

test('the open month counts its measured cost so far from the summary', () => {
  const open = month({ month: '2026-11', open: true, costOre: null, knownNetOre: 5000 });
  const view = coverageOverview([open, month({ knownNetOre: 10000 })], { month: '2026-11', cost: { actualOre: '20000' } });
  assert.equal(view.costOre, 60000);
  assert.equal(view.supportOre, 15000);
  assert.deepEqual(view.rows.map((row) => row.state), ['so_far', 'finalized']);
  assert.equal(coverageOverview([open], null).rows[0].state, 'open_unknown');
  assert.equal(coverageOverview([open], { month: '2026-10', cost: { actualOre: '20000' } }).costOre, 0);
});

test('a closed month without a finalized cost is flagged, not counted as free', () => {
  const view = coverageOverview([month({ costOre: null, knownNetOre: 3000 }), month({ month: '2026-09' })]);
  assert.deepEqual(view.missingMonths, ['2026-10']);
  assert.equal(view.costOre, 40000);
  assert.equal(view.supportOre, 3000);
});

test('months before the lab was metered are left out', () => {
  const view = coverageOverview([month(), month({ month: '2026-09', kwh: null, costOre: null, knownNetOre: 0 })]);
  assert.deepEqual(view.rows.map((row) => row.month), ['2026-10']);
  assert.deepEqual(view.missingMonths, []);
});

test('no data gives no percentage', () => {
  for (const input of [undefined, [], [month({ month: '2026-11', open: true, costOre: null })]]) {
    const view = coverageOverview(input);
    assert.equal(view.percent, null);
    assert.equal(view.costOre, 0);
  }
});

test('a refund month lowers total support', () => {
  const view = coverageOverview([month({ knownNetOre: -2000 }), month({ month: '2026-09', knownNetOre: 5000 })]);
  assert.equal(view.supportOre, 3000);
});

test('the open month carries the projected total only for a real estimate', () => {
  const open = month({ month: '2026-11', open: true, costOre: null });
  const estimate = { status: 'estimated', totalOre: '105680', lowOre: '93252', highOre: '118108' };
  const view = coverageOverview([open], { month: '2026-11', cost: { actualOre: '23912', estimate } });
  assert.deepEqual(view.projection, { month: '2026-11', totalOre: 105680, lowOre: 93252, highOre: 118108, soFarOre: 23912 });
  // The projection is shown beside the totals; it is never added to them.
  assert.equal(view.costOre, 23912);
  assert.equal(coverageOverview([open], { month: '2026-11', cost: { actualOre: '23912', estimate: { status: 'insufficient_data' } } }).projection, null);
  assert.equal(coverageOverview([open], { month: '2026-11', cost: { actualOre: '23912', estimate: null } }).projection, null);
  assert.equal(coverageOverview([month()], { month: '2026-10', cost: { estimate } }).projection, null);
});

test('later support never repays a shortfall the owner already funded', () => {
  // Newest first, as the endpoint returns them. September cost 100 DKK with no support; October cost nothing and received 100 DKK.
  const view = coverageOverview([
    month({ costOre: 0, knownNetOre: 10000, appliedOre: 0, ownerFundedOre: 0, carryForwardOre: 10000 }),
    month({ month: '2026-09', costOre: 10000, knownNetOre: 0, appliedOre: 0, ownerFundedOre: 10000, carryForwardOre: 0 }),
  ]);
  assert.deepEqual([view.costOre, view.coveredOre, view.ownerOre, view.creditOre, view.percent], [10000, 0, 10000, 10000, 0]);
});

test('reconciled allocations include credit from before the window', () => {
  const view = coverageOverview([month({ costOre: 40000, knownNetOre: 0, appliedOre: 40000, ownerFundedOre: 0, carryForwardOre: 5000 })]);
  assert.deepEqual([view.coveredOre, view.ownerOre, view.creditOre, view.percent], [40000, 0, 5000, 100]);
});

test('the open month applies the credit carried into it, then its own support', () => {
  const open = month({ month: '2026-11', open: true, costOre: null, knownNetOre: 1000 });
  const closed = month({ costOre: 40000, knownNetOre: 50000, appliedOre: 40000, ownerFundedOre: 0, carryForwardOre: 10000 });
  const view = coverageOverview([open, closed], { month: '2026-11', cost: { actualOre: '15000' } });
  assert.deepEqual([view.costOre, view.coveredOre, view.ownerOre, view.creditOre], [55000, 51000, 4000, 0]);
});
