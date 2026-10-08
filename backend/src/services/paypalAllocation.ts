import { createHash } from 'node:crypto';
import { and, desc, eq, lt, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityCostStatements, paypalMonthAllocations, paypalPostings, paypalTransactions, paypalWebhookInbox } from '../db/schema/index.ts';
import { startOfLocalDateUtc } from './energyAccounting.ts';

export function allocationMonth(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit' }).format(date);
}
function nextMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
}
function safeOre(value: unknown): number {
  const amount = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(amount)) throw new Error('Unsafe allocation amount');
  return amount as number;
}
export type AllocationResult = { status: 'known' | 'cost_unknown' | 'unresolved'; appliedOre: number | null;
  ownerRemainderOre: number | null; ownerAdjustmentOre: number | null; closingBalanceOre: number | null };

export function allocateMonth(openingBalanceOre: number | null, receivedNetOre: number, costOre: number | null,
  unresolvedCount = 0): AllocationResult {
  if (openingBalanceOre === null || unresolvedCount > 0) return { status: 'unresolved', appliedOre: null,
    ownerRemainderOre: null, ownerAdjustmentOre: null, closingBalanceOre: null };
  const available = safeOre(openingBalanceOre + receivedNetOre);
  if (costOre === null || costOre < 0) return { status: 'cost_unknown', appliedOre: null,
    ownerRemainderOre: null, ownerAdjustmentOre: null, closingBalanceOre: null };
  const applied = Math.min(costOre, Math.max(0, available));
  const closing = safeOre(available - applied);
  return { status: 'known', appliedOre: applied, ownerRemainderOre: costOre - applied,
    ownerAdjustmentOre: Math.max(0, -closing), closingBalanceOre: closing };
}

function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export async function recalculatePaypalAllocations(throughMonth: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(throughMonth)) throw new Error('Invalid allocation month');
  if (throughMonth > allocationMonth(new Date())) throw new Error('Future allocation month');
  const end = startOfLocalDateUtc(`${nextMonth(throughMonth)}-01`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(238001)`);
    const [postings, statements, unresolvedTransactions, reviewEvents] = await Promise.all([
      tx.select().from(paypalPostings).where(and(eq(paypalPostings.environment, 'live'), eq(paypalPostings.currency, 'DKK'), lt(paypalPostings.effective_at, end))).orderBy(paypalPostings.effective_at, paypalPostings.id).limit(100001),
      tx.select().from(electricityCostStatements).where(and(eq(electricityCostStatements.finalized, true), lte(electricityCostStatements.period_end, end))).orderBy(electricityCostStatements.period_start, desc(electricityCostStatements.revision)).limit(1001),
      tx.select({ id: paypalTransactions.id, effective_at: paypalTransactions.effective_at, observed_at: paypalTransactions.observed_at })
        .from(paypalTransactions).where(and(eq(paypalTransactions.environment, 'live'), eq(paypalTransactions.status, 'net_unresolved'))).limit(1001),
      tx.select({ id: paypalWebhookInbox.id, event_at: paypalWebhookInbox.event_at, received_at: paypalWebhookInbox.received_at })
        .from(paypalWebhookInbox).where(and(eq(paypalWebhookInbox.environment, 'live'), eq(paypalWebhookInbox.status, 'needs_review'))).limit(1001),
    ]);
    if (postings.length > 100000 || statements.length > 1000 || unresolvedTransactions.length > 1000 || reviewEvents.length > 1000)
      throw new Error('Allocation source limit exceeded');
    const sourceMonths = [throughMonth, ...postings.map((row) => allocationMonth(row.effective_at)),
      ...statements.map((row) => allocationMonth(row.period_start))].filter((month) => month <= throughMonth);
    const firstMonth = sourceMonths.sort()[0];
    const selectedStatements = new Map<string, typeof statements>();
    for (const statement of statements) {
      const month = allocationMonth(statement.period_start);
      if (month > throughMonth) continue;
      const rows = selectedStatements.get(month) || [];
      if (!rows.some((row) => row.contract_id === statement.contract_id)) rows.push(statement);
      selectedStatements.set(month, rows);
    }
    let opening: number | null = 0;
    let cursor = firstMonth;
    let ledgerRevision = 0;
    let priorMonthAllocationId: number | null = null;
    const created: Array<{ month: string; revision: number; status: string }> = [];
    for (let index = 0; cursor <= throughMonth && index < 120; index++, cursor = nextMonth(cursor)) {
      const monthPostings = postings.filter((row) => allocationMonth(row.effective_at) === cursor);
      const received = safeOre(monthPostings.reduce((sum, row) => sum + row.amount_ore, 0));
      ledgerRevision = Math.max(ledgerRevision, ...monthPostings.map((row) => row.id));
      const monthStatements = selectedStatements.get(cursor) || [];
      const costStatement = monthStatements.length === 1 ? monthStatements[0] : null;
      const calculation = costStatement?.calculation as { calculatedLabCostOre?: string; variableCostComplete?: boolean; fixedFeeStatus?: string } | undefined;
      const cost = calculation?.variableCostComplete === true && calculation.fixedFeeStatus === 'known' &&
        typeof calculation.calculatedLabCostOre === 'string' ? safeOre(calculation.calculatedLabCostOre) : null;
      const blockers = [
        ...unresolvedTransactions.filter((row) => allocationMonth(row.effective_at || row.observed_at) <= cursor).map((row) => `t:${row.id}`),
        ...reviewEvents.filter((row) => allocationMonth(row.event_at || row.received_at) <= cursor).map((row) => `e:${row.id}`),
      ];
      const calculated = allocateMonth(opening, received, cost, blockers.length);
      const source = fingerprint({ month: cursor, opening, received, costStatementId: costStatement?.id || null,
        costStatementIds: monthStatements.map((row) => row.id).sort((a, b) => a - b),
        costStatementRevision: costStatement?.revision || null, cost, postings: monthPostings.map((row) => [row.id, row.amount_ore]),
        blockers, priorMonthAllocationId });
      const [prior] = await tx.select().from(paypalMonthAllocations).where(eq(paypalMonthAllocations.month, cursor))
        .orderBy(desc(paypalMonthAllocations.revision)).limit(1);
      if (prior?.source_fingerprint !== source) {
        const revision = (prior?.revision || 0) + 1;
        const [inserted] = await tx.insert(paypalMonthAllocations).values({ month: cursor, revision, previous_id: prior?.id || null,
          source_fingerprint: source, cost_statement_id: costStatement?.id || null, ledger_revision: ledgerRevision,
          status: calculated.status, cost_ore: cost, received_net_ore: received, opening_balance_ore: opening,
          applied_ore: calculated.appliedOre, owner_remainder_ore: calculated.ownerRemainderOre,
          owner_adjustment_ore: calculated.ownerAdjustmentOre, closing_balance_ore: calculated.closingBalanceOre,
          unresolved_count: blockers.length }).returning({ id: paypalMonthAllocations.id });
        created.push({ month: cursor, revision, status: calculated.status });
        priorMonthAllocationId = inserted.id;
      } else {
        priorMonthAllocationId = prior.id;
      }
      opening = calculated.closingBalanceOre;
    }
    if (cursor <= throughMonth) throw new Error('Allocation range exceeds 120 months');
    return { throughMonth, created, closingBalanceOre: opening };
  });
}

export async function latestPaypalAllocation(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid allocation month');
  const [row] = await db.select().from(paypalMonthAllocations).where(eq(paypalMonthAllocations.month, month))
    .orderBy(desc(paypalMonthAllocations.revision)).limit(1);
  return row || null;
}
