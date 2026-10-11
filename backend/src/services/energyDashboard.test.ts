import test from 'node:test';
import assert from 'node:assert/strict';
// The dashboard imports DB-backed funding services; these pure helpers do not
// connect, but client initialization still requires a configured URL.
process.env.DATABASE_URL ||= 'postgres://postgres:postgres@127.0.0.1:5432/unused';
const { parseEnergyMonth, parseHistoryRange, safeHosts } = await import('./energyDashboard.ts');

test('Copenhagen month follows local clock at UTC day boundaries', () => {
  assert.equal(parseEnergyMonth(undefined, new Date('2026-10-31T23:30:00Z')), '2026-11');
  assert.equal(parseEnergyMonth('2026-02'), '2026-02');
  assert.throws(() => parseEnergyMonth('2026-13'), /INVALID_MONTH/);
  assert.throws(() => parseEnergyMonth(['2026-02']), /INVALID_MONTH/);
});
test('history ranges are bounded', () => {
  assert.equal(parseHistoryRange(undefined), '24h');
  assert.equal(parseHistoryRange('7d'), '7d');
  assert.throws(() => parseHistoryRange('30d'), /INVALID_RANGE/);
});
test('member host DTO allows only safe aliases and observations', () => {
  const source = { id: 29, target_host: 'ilo.secret.internal', username: 'admin', system_uuid: 'private',
    watts: '144.5', mode: 'Low', observed_at: new Date('2026-10-08T12:00:00Z'), collection_enabled: true,
    last_error_code: null };
  const [host] = safeHosts([source], new Date('2026-10-08T12:01:00Z'));
  assert.equal(host.alias, 'Server 01');
  assert.equal(host.watts, 144.5);
  assert.equal(JSON.stringify(host).includes('secret'), false);
  assert.equal(JSON.stringify(host).includes('private'), false);
  assert.equal(JSON.stringify(host).includes('admin'), false);
});

const { fundingProgress, parseMonthCount, parseHouseholdShareMode } = await import('./energyDashboard.ts');
const { adminBudgetCsv, flattenDto, memberSummaryCsv } = await import('./energyExports.ts');

test('member months are bounded: no future month and at most 120 months back', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  assert.equal(parseEnergyMonth('2026-10', now), '2026-10');
  assert.throws(() => parseEnergyMonth('2026-11', now), /INVALID_MONTH/);
  assert.throws(() => parseEnergyMonth('9999-01', now), /INVALID_MONTH/);
  assert.equal(parseEnergyMonth('2016-11', now), '2016-11');
  assert.throws(() => parseEnergyMonth('2016-10', now), /INVALID_MONTH/);
  assert.equal(parseMonthCount(undefined), 12);
  assert.equal(parseMonthCount('24'), 24);
  for (const bad of ['0', '25', '1.5', ['3'], 'x']) assert.throws(() => parseMonthCount(bad), /INVALID_COUNT/);
  assert.equal(parseHouseholdShareMode('paid'), 'paid');
  assert.throws(() => parseHouseholdShareMode(true), /INVALID_SHARE_MODE/);
});

const reconciled = (allocationCostOre: number | null, appliedOre: number | null) => ({ status: 'reconciled', allocationCostOre, appliedOre,
  ownerFundedOre: allocationCostOre === null || appliedOre === null ? null : allocationCostOre - appliedOre, estimateInputs: null }) as any;

test('funding progress uses the allocation cost and never yields NaN, infinity or a false 100%', () => {
  // Regression: cost.actualOre arrives as a decimal string; the bar must still render.
  assert.deepEqual(fundingProgress(reconciled(100000, 9600), { status: 'finalized', actualOre: '100000' }, true),
    { basis: 'finalized_lab_cost', costOre: 100000, appliedOre: 9600, ownerRemainderOre: 90400, status: 'known', percent: 9.6 });
  assert.equal(fundingProgress(reconciled(0, 0), { status: 'finalized', actualOre: '0' }, true).percent, null);
  assert.equal(fundingProgress(reconciled(0, 0), { status: 'finalized', actualOre: '0' }, true).status, 'no_cost');
  assert.equal(fundingProgress(reconciled(-5, 0), { status: 'finalized', actualOre: '-5' }, true).percent, null);
  assert.equal(fundingProgress(reconciled(null, null), { status: 'finalized', actualOre: null }, true).percent, null);
  assert.equal(fundingProgress(reconciled(1000, 999), { status: 'finalized', actualOre: '1000' }, true).percent, 99.9);
  assert.equal(fundingProgress(null, { status: 'calculated', actualOre: '1000' }, false).status, 'unavailable');
  // Open month estimate: same allocation rule, labeled as an estimate.
  const open = { status: 'partial', estimateInputs: { openingBalanceOre: 500, receivedNetOre: 9600 } } as any;
  assert.deepEqual(fundingProgress(open, { status: 'calculated', actualOre: '50000' }, false),
    { basis: 'current_estimate', costOre: 50000, appliedOre: 10100, ownerRemainderOre: 39900, status: 'estimate', percent: 20.2 });
  assert.equal(fundingProgress(open, { status: 'calculated', actualOre: '5000' }, false).percent, 100);
  assert.equal(fundingProgress(open, { status: 'partial', actualOre: '5000' }, false).status, 'cost_incomplete');
  assert.equal(fundingProgress(open, { status: 'calculated', actualOre: '99999999999999999999' }, false).percent, null);
  assert.equal(fundingProgress(open, { status: 'calculated', actualOre: '5000' }, true).status, 'not_finalized');
});

test('member CSV is exactly the DTO, formula-safe; admin CSV holds selected record fields only', () => {
  const dto = { month: '2026-08', cost: { actualOre: '100', components: [{ label: '=HYPERLINK("x")', ore: '-4' }] }, funding: { appliedOre: -400, held: null },
    household: { shared: false }, at: new Date('2026-08-01T00:00:00Z'), empty: [] };
  assert.deepEqual(flattenDto(dto).map(([field]) => field), ['month', 'cost.actualOre', 'cost.components.0.label', 'cost.components.0.ore',
    'funding.appliedOre', 'funding.held', 'household.shared', 'at', 'empty']);
  const body = memberSummaryCsv(dto);
  assert.match(body, /^field,value\r\n/);
  assert.match(body, /cost\.components\.0\.label,"'=HYPERLINK\(""x""\)"/);
  assert.match(body, /cost\.components\.0\.ore,'-4/);
  assert.match(body, /funding\.appliedOre,-400\r\n/);
  assert.match(body, /household\.shared,false/);
  const admin = adminBudgetCsv({
    statements: [{ id: 3, contract_id: 1, period_start: new Date('2026-07-31T22:00:00Z'), period_end: new Date('2026-08-31T22:00:00Z'), revision: 2,
      previous_id: 2, finalized: true, created_at: new Date('2026-09-02T00:00:00Z'),
      calculation: { calculatedLabCostOre: '100005', variableCostOre: '-5', allocatedFixedFeeOre: '0', fixedFeeStatus: 'known', variableCostComplete: true,
        labKwh: '400.5', household: { meterId: 'METER-SECRET' }, actualBills: [{ note: 'private note' }] } }],
    allocations: [{ id: 9, month: '2026-08', revision: 1, previous_id: null, source_fingerprint: 'FINGERPRINT', cost_statement_id: 3, ledger_revision: 7,
      status: 'known', cost_ore: 100005, received_net_ore: 9600, opening_balance_ore: 0, applied_ore: 9600, owner_remainder_ore: 90405,
      owner_adjustment_ore: 0, closing_balance_ore: 0, unresolved_count: 0, created_at: new Date('2026-09-02T00:00:00Z') }],
  } as any);
  const [header, statement, allocation] = admin.trim().split('\r\n');
  assert.match(header, /^record_type,month,record_id/);
  assert.match(statement, /^cost_statement,2026-08,3,2,2,.*,finalized,1,,,1000\.05,-0\.05,0\.00,known,true,400\.5,/);
  assert.match(allocation, /^allocation,2026-08,9,1,,.*,known,,3,7,1000\.05,.*,0\.00,96\.00,96\.00,904\.05,0\.00,0\.00,0$/);
  assert.doesNotMatch(admin, /METER-SECRET|private note|FINGERPRINT/);
});
