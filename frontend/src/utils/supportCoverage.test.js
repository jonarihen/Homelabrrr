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
