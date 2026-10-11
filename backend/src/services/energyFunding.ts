import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalPostings, paypalReconciliation, paypalTransactions } from '../db/schema/index.ts';
import { latestPaypalAllocation } from './paypalAllocation.ts';
import { openPaymentStateTotals } from './paypalPaymentStates.ts';
import { startOfLocalDateUtc } from './energyAccounting.ts';

type Posting = Pick<typeof paypalPostings.$inferSelect, 'id' | 'posting_kind' | 'amount_ore'>;

export function summarizeFundingPostings(rows: Posting[]) {
  const totals = { grossOre: 0, feeDebitsOre: 0, feeCreditsOre: 0, refundDebitsOre: 0, knownNetOre: 0 };
  for (const row of rows) {
    if (!Number.isSafeInteger(row.amount_ore)) throw new Error('Unsafe payment posting');
    switch (row.posting_kind) {
      case 'gross': totals.grossOre += row.amount_ore; break;
      case 'fee': totals.feeDebitsOre -= row.amount_ore; break;
      case 'fee_credit': totals.feeCreditsOre += row.amount_ore; break;
      case 'refund': case 'reversal': totals.refundDebitsOre -= row.amount_ore; break;
      default: throw new Error('Unknown payment posting kind');
    }
    totals.knownNetOre += row.amount_ore;
  }
  if (Object.values(totals).some((value) => !Number.isSafeInteger(value))) throw new Error('Unsafe payment total');
  return totals;
}

export async function monthlyEnergyFunding(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid funding month');
  const [year, number] = month.split('-').map(Number);
  const from = startOfLocalDateUtc(`${month}-01`);
  const next = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
  const to = startOfLocalDateUtc(`${next}-01`);
  const [postings, ledgerHead, unresolved, allocation, reconciliation, held] = await Promise.all([
    db.select({ id: paypalPostings.id, posting_kind: paypalPostings.posting_kind, amount_ore: paypalPostings.amount_ore })
      .from(paypalPostings).where(and(eq(paypalPostings.environment, 'live'), eq(paypalPostings.currency, 'DKK'),
        gte(paypalPostings.effective_at, from), lt(paypalPostings.effective_at, to))).limit(100001),
    db.select({ id: sql<number>`coalesce(max(${paypalPostings.id}), 0)::int` }).from(paypalPostings)
      .where(and(eq(paypalPostings.environment, 'live'), eq(paypalPostings.currency, 'DKK'), lt(paypalPostings.effective_at, to))),
    db.select({ id: paypalTransactions.id }).from(paypalTransactions).where(and(eq(paypalTransactions.environment, 'live'),
      eq(paypalTransactions.status, 'net_unresolved'), lt(paypalTransactions.effective_at, to))).limit(1001),
    latestPaypalAllocation(month),
    db.select({ last_run_at: paypalReconciliation.last_run_at }).from(paypalReconciliation)
      .where(eq(paypalReconciliation.environment, 'live')).limit(1),
    openPaymentStateTotals('live'),
  ]);
  if (postings.length > 100000 || unresolved.length > 1000) throw new Error('Funding source limit exceeded');
  const totals = summarizeFundingPostings(postings);
  const head = ledgerHead[0]?.id || 0;
  const allocationCurrent = Boolean(allocation) && allocation!.ledger_revision >= head && unresolved.length === 0;
  const known = allocationCurrent && allocation!.status === 'known';
  const opening = known ? allocation!.opening_balance_ore : null;
  return { status: known ? 'reconciled' : allocation ? 'partial' : 'unavailable', ...totals,
    eligibleNetOre: known && opening !== null ? Math.max(0, opening + allocation!.received_net_ore) : null,
    // Credit carried in from earlier months, kept apart from money newly
    // received in this month (knownNetOre) so neither is counted twice.
    openingCreditOre: known && opening !== null ? Math.max(0, opening) : null,
    appliedOre: known ? allocation!.applied_ore : null,
    ownerFundedOre: known ? allocation!.owner_remainder_ore : null,
    ownerAdjustmentOre: known ? allocation!.owner_adjustment_ore : null,
    carryForwardOre: known ? Math.max(0, allocation!.closing_balance_ore ?? 0) : null,
    // The finalized lab cost the allocation applied credit against. It is the
    // only valid funding-progress denominator for a known allocation.
    allocationCostOre: known ? allocation!.cost_ore : null,
    unresolvedOre: unresolved.length || (allocation?.unresolved_count || 0) ? null : 0,
    // Open pending/disputed PayPal states, across all months. Informational
    // only: never part of net received and never subtracted.
    held: { pendingCount: held.pendingCount, pendingOre: held.pendingAmountUnknown ? null : held.pendingOre,
      disputeCount: held.disputeCount, disputedOre: held.disputeAmountUnknown ? null : held.disputedOre },
    reconciledAt: reconciliation[0]?.last_run_at ?? null,
    revisions: { ledgerRevision: head, allocationId: allocation?.id ?? null, allocationRevision: allocation?.revision ?? null,
      allocationCurrent, costStatementId: allocation?.cost_statement_id ?? null },
    // Inputs for a clearly labeled open-month estimate (see energyDashboard);
    // only present when the allocation is current and its opening is known.
    estimateInputs: allocationCurrent && allocation!.status === 'cost_unknown' && allocation!.opening_balance_ore !== null
      ? { openingBalanceOre: allocation!.opening_balance_ore, receivedNetOre: allocation!.received_net_ore } : null,
  };
}
