import { and, asc, count, eq, gt, inArray, min } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalIntents, paypalPostings, paypalReconciliation, paypalSubscriptions, paypalTransactions, paypalWebhookInbox, users } from '../db/schema/index.ts';
import { PayPalError } from './paypalClient.ts';
import { oreToDkk } from './paypalMoney.ts';
import { csvLine } from '../utils/csv.ts';

function env(value: unknown): 'sandbox' | 'live' {
  if (value !== 'sandbox' && value !== 'live') throw new PayPalError('INVALID_ENVIRONMENT', 400);
  return value;
}

/** Reconciliation coverage and backlog for the admin view; counts only, no payer data. */
export async function paypalReconciliationHealth(value: unknown) {
  const environment = env(value);
  const [[recon], [unresolved], [uncertain], [failing], [review], [inbox], [cancelling]] = await Promise.all([
    db.select().from(paypalReconciliation).where(eq(paypalReconciliation.environment, environment)).limit(1),
    db.select({ count: count(), oldest: min(paypalTransactions.observed_at) }).from(paypalTransactions)
      .where(and(eq(paypalTransactions.environment, environment), eq(paypalTransactions.status, 'net_unresolved'))),
    db.select({ count: count() }).from(paypalIntents).where(and(eq(paypalIntents.environment, environment),
      inArray(paypalIntents.status, ['capture_unknown', 'capturing']))),
    db.select({ count: count() }).from(paypalSubscriptions).where(and(eq(paypalSubscriptions.environment, environment),
      gt(paypalSubscriptions.reconcile_failures, 0))),
    db.select({ count: count() }).from(paypalWebhookInbox).where(and(eq(paypalWebhookInbox.environment, environment),
      eq(paypalWebhookInbox.status, 'needs_review'))),
    db.select({ count: count() }).from(paypalWebhookInbox).where(and(eq(paypalWebhookInbox.environment, environment),
      inArray(paypalWebhookInbox.status, ['pending', 'processing']))),
    db.select({ count: count() }).from(paypalSubscriptions).where(and(eq(paypalSubscriptions.environment, environment),
      eq(paypalSubscriptions.status, 'CANCELLATION_REQUESTED'))),
  ]);
  return {
    environment,
    status: recon?.status ?? 'never_run',
    lastRunAt: recon?.last_run_at ?? null,
    lastSuccessAt: recon?.last_success_at ?? null,
    eventCursorAt: recon?.cursor_at ?? null,
    errorCode: recon?.error_code ?? null,
    failedItems: recon?.failed_items ?? 0,
    consecutiveFailures: recon?.consecutive_failures ?? 0,
    unresolvedTransactions: unresolved.count,
    oldestUnresolvedAt: unresolved.oldest ?? null,
    uncertainCaptures: uncertain.count,
    failingSubscriptions: failing.count,
    reviewEvents: review.count,
    pendingInboxEvents: inbox.count,
    cancellationsAwaitingConfirmation: cancelling.count,
  };
}

function signedDkk(ore: number) { return `${ore < 0 ? '-' : ''}${oreToDkk(Math.abs(ore))}`; }

/** Private admin CSV of the append-only ledger for one environment. */
export async function paypalLedgerCsv(value: unknown) {
  const environment = env(value);
  const rows = await db.select({ id: paypalPostings.id, effective_at: paypalPostings.effective_at, posted_at: paypalPostings.posted_at,
    posting_kind: paypalPostings.posting_kind, amount_ore: paypalPostings.amount_ore, currency: paypalPostings.currency,
    provider_transaction_id: paypalPostings.provider_transaction_id, original_transaction_id: paypalPostings.original_transaction_id,
    intent_id: paypalPostings.intent_id, verification: paypalPostings.verification, username: users.username })
    .from(paypalPostings).leftJoin(users, eq(users.id, paypalPostings.user_id))
    .where(eq(paypalPostings.environment, environment)).orderBy(asc(paypalPostings.effective_at), asc(paypalPostings.id)).limit(50_001);
  if (rows.length > 50_000) throw new PayPalError('EXPORT_TOO_LARGE', 413);
  const lines = [csvLine(['posting_id', 'environment', 'effective_at', 'posted_at', 'kind', 'amount', 'currency',
    'provider_transaction_id', 'original_transaction_id', 'intent_id', 'member', 'verification'])];
  for (const row of rows) lines.push(csvLine([row.id, environment, row.effective_at, row.posted_at, row.posting_kind,
    { numeric: signedDkk(row.amount_ore) }, row.currency, row.provider_transaction_id, row.original_transaction_id, row.intent_id,
    row.username ?? '', row.verification]));
  return `${lines.join('\r\n')}\r\n`;
}
