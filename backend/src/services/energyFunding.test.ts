import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { paypalMonthAllocations, paypalPostings, paypalReconciliation } from '../db/schema/index.ts';

const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
const { monthlyEnergyFunding, summarizeFundingPostings } = await import('./energyFunding.ts');
const { closeDb } = await import('../db/client.ts');
test.after(async () => { await closeDb(); await fixture.drop(); });

test('gross, actual fees, refunds and fee credits resolve to one known net', () => {
  const totals = summarizeFundingPostings([
    { id: 1, posting_kind: 'gross', amount_ore: 1000 },
    { id: 2, posting_kind: 'fee', amount_ore: -80 },
    { id: 3, posting_kind: 'refund', amount_ore: -200 },
    { id: 4, posting_kind: 'fee_credit', amount_ore: 20 },
  ]);
  assert.deepEqual(totals, { grossOre: 1000, feeDebitsOre: 80, feeCreditsOre: 20, refundDebitsOre: 200, knownNetOre: 740 });
});

test('private month summary reads live verified postings and current allocation only', async () => {
  const at = new Date('2026-09-12T12:00:00Z');
  const [gross, fee] = await fixture.db.insert(paypalPostings).values([
    { environment: 'live', merchant_id: 'private-merchant', provider_transaction_id: 'capture-1', posting_kind: 'gross',
      source_id: 'capture-1', amount_ore: 1000, currency: 'DKK', effective_at: at, verification: 'fixture' },
    { environment: 'live', merchant_id: 'private-merchant', provider_transaction_id: 'capture-1', posting_kind: 'fee',
      source_id: 'capture-1', amount_ore: -80, currency: 'DKK', effective_at: at, verification: 'fixture' },
  ]).returning();
  await fixture.db.insert(paypalReconciliation).values({ environment: 'live', last_run_at: at, status: 'ok' });
  await fixture.db.insert(paypalMonthAllocations).values({ month: '2026-09', revision: 1, source_fingerprint: 'fixture',
    ledger_revision: fee.id, status: 'known', cost_ore: 1500, received_net_ore: 920, opening_balance_ore: 0,
    applied_ore: 920, owner_remainder_ore: 580, owner_adjustment_ore: 0, closing_balance_ore: 0 });
  const summary = await monthlyEnergyFunding('2026-09');
  assert.equal(summary.status, 'reconciled');
  assert.equal(summary.grossOre, 1000);
  assert.equal(summary.feeDebitsOre, 80);
  assert.equal(summary.knownNetOre, 920);
  assert.equal(summary.appliedOre, 920);
  assert.equal(summary.ownerFundedOre, 580);
  assert.doesNotMatch(JSON.stringify(summary), /private-merchant|capture-1|source_fingerprint/);
  await fixture.db.insert(paypalPostings).values({ environment: 'live', merchant_id: 'private-merchant',
    provider_transaction_id: 'capture-2', posting_kind: 'gross', source_id: 'capture-2',
    amount_ore: 100, currency: 'DKK', effective_at: at, verification: 'fixture' });
  const stale = await monthlyEnergyFunding('2026-09');
  assert.equal(stale.status, 'partial');
  assert.equal(stale.appliedOre, null);
  assert.equal(stale.knownNetOre, 1020);
  assert.ok(gross.id < fee.id);
});
