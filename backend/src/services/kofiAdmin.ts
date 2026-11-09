import { and, count, desc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { kofiMemberEmails, paypalTransactions, paypalWebhookInbox, users } from '../db/schema/index.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { PayPalError } from './paypalClient.ts';
import { postProviderAdjustment, postReceipt, type ReceiptKind } from './paypalLedger.ts';
import { dismissPaypalReviewEvent } from './paypalReview.ts';
import { KOFI_ENVIRONMENT, KOFI_IGNORED_CODES, KOFI_INBOX_SOURCE, KOFI_LINKABLE_REASONS, KOFI_MERCHANT, KOFI_RECEIPT_KINDS, KOFI_SETTLEABLE_REASON,
  decimalToMinorUnits, ensureKofiEmailHashKey, evaluateKofiEvent, existingKofiEmailHashKey, hashKofiEmail, kofiConfigRow, kofiEmailHint,
  kofiWebhookUrl, normalizeKofiEmail, recordKofiReceipt } from './kofi.ts';

// Administrator side of the Ko-fi integration: status, the review queue
// (link, record in DKK, retry, dismiss), receipts (fee entry, reversal) and
// the payer emails bound to members. Nothing here returns the verification
// token, the email hash key or an email hash.

type InboxRow = typeof paypalWebhookInbox.$inferSelect;
type TransactionRow = typeof paypalTransactions.$inferSelect;
const kofiEvents = eq(paypalWebhookInbox.source, KOFI_INBOX_SOURCE);
const kofiReceipts = and(eq(paypalTransactions.environment, KOFI_ENVIRONMENT), eq(paypalTransactions.merchant_id, KOFI_MERCHANT),
  inArray(paypalTransactions.provider_kind, [...KOFI_RECEIPT_KINDS]));
const scope = (userId: number | null) => ({ environment: KOFI_ENVIRONMENT, merchantId: KOFI_MERCHANT, intentId: null, userId });

// ─── Input parsing ───────────────────────────────────────────────────────────

export function kofiReviewId(value: unknown): string {
  if (typeof value !== 'string' || !/^live:kofi:[A-Za-z0-9_-]{1,128}$/.test(value)) throw new PayPalError('INVALID_ID', 400);
  return value;
}
export function kofiRowId(value: unknown): number {
  const id = typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id)) throw new PayPalError('INVALID_ID', 400);
  return id;
}
function memberId(value: unknown, allowNone: boolean): number | null {
  if (value === null && allowNone) return null;
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new PayPalError('INVALID_USER', 400);
  return id;
}
function optionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > 500) throw new PayPalError('INVALID_NOTE', 400);
  return value.trim() || null;
}
function amountOre(value: unknown): number {
  const ore = decimalToMinorUnits(value);
  if (ore === null) throw new PayPalError('INVALID_AMOUNT', 400);
  return ore;
}
function page(offset: unknown): number {
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new PayPalError('INVALID_OFFSET', 400);
  return offset;
}
const retained = (payload: unknown) => Boolean(payload) && typeof payload === 'object' && Object.keys(payload as object).length > 0;
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : null);

// ─── Status ──────────────────────────────────────────────────────────────────

/** Setup and health for the admin panel. Counts and timestamps only. */
export async function kofiAdminStatus() {
  const [config, [lastEvent], [lastTest], [lastReview], statuses, [settleable], [awaitingFee]] = await Promise.all([
    kofiConfigRow(),
    db.select({ received_at: paypalWebhookInbox.received_at, event_type: paypalWebhookInbox.event_type, status: paypalWebhookInbox.status,
      error_code: paypalWebhookInbox.error_code }).from(paypalWebhookInbox).where(kofiEvents)
      .orderBy(desc(paypalWebhookInbox.received_at), desc(paypalWebhookInbox.id)).limit(1),
    db.select({ received_at: paypalWebhookInbox.received_at }).from(paypalWebhookInbox)
      .where(and(kofiEvents, eq(paypalWebhookInbox.error_code, 'TEST_EVENT'))).orderBy(desc(paypalWebhookInbox.received_at)).limit(1),
    db.select({ received_at: paypalWebhookInbox.received_at, error_code: paypalWebhookInbox.error_code }).from(paypalWebhookInbox)
      .where(and(kofiEvents, isNotNull(paypalWebhookInbox.error_code), notInArray(paypalWebhookInbox.error_code, KOFI_IGNORED_CODES)))
      .orderBy(desc(paypalWebhookInbox.received_at), desc(paypalWebhookInbox.id)).limit(1),
    db.select({ status: paypalWebhookInbox.status, count: count() }).from(paypalWebhookInbox).where(kofiEvents).groupBy(paypalWebhookInbox.status),
    db.select({ count: count() }).from(paypalWebhookInbox).where(and(kofiEvents, eq(paypalWebhookInbox.status, 'needs_review'),
      eq(paypalWebhookInbox.error_code, KOFI_SETTLEABLE_REASON))),
    db.select({ count: count() }).from(paypalTransactions).where(and(kofiReceipts, eq(paypalTransactions.status, 'net_unresolved'))),
  ]);
  const byStatus = (name: string) => statuses.find((row) => row.status === name)?.count ?? 0;
  const webhook = kofiWebhookUrl();
  const rejectedAt = config?.last_rejected_at ?? null;
  const reviewAt = lastReview?.received_at ?? null;
  const rejectionIsLatest = rejectedAt !== null && (reviewAt === null || rejectedAt.getTime() >= reviewAt.getTime());
  const outcome = !lastEvent ? null
    : lastEvent.status === 'pending' || lastEvent.status === 'processing' ? 'pending'
      : lastEvent.status === 'processed' && lastEvent.error_code === 'TEST_EVENT' ? 'ignored_test' : lastEvent.status;
  return {
    enabled: config?.enabled === true,
    configured: Boolean(config?.verification_token && config.page_url),
    tokenStored: Boolean(config?.verification_token),
    tokenUpdatedAt: config?.token_updated_at ?? null,
    pageUrl: config?.page_url ?? null,
    webhookUrl: webhook.url,
    webhookUrlError: webhook.error,
    updatedAt: config?.updated_at ?? null,
    lastEventAt: lastEvent?.received_at ?? null,
    lastEventType: lastEvent?.event_type || null,
    lastEventOutcome: outcome,
    lastTestEventAt: lastTest?.received_at ?? null,
    lastErrorAt: rejectionIsLatest ? rejectedAt : reviewAt,
    lastErrorCode: rejectionIsLatest ? config!.last_rejected_code : lastReview?.error_code ?? null,
    counts: { pending: byStatus('pending') + byStatus('processing'), needsReview: byStatus('needs_review'),
      awaitingFee: awaitingFee.count, awaitingDkkAmount: settleable.count },
  };
}

// ─── Review queue ────────────────────────────────────────────────────────────

/**
 * Ko-fi events held for review. Payer details come from the stored payload and
 * are null once it has been emptied. `matchedUserId` is the member the payer
 * email is bound to now, looked up with one query for the whole page.
 */
export async function listKofiReviewEvents(status: unknown = 'needs_review', offset: unknown = 0) {
  const statuses = status === 'needs_review' ? ['needs_review'] : status === 'resolved' ? ['dismissed']
    : status === 'all' ? ['needs_review', 'dismissed'] : null;
  if (!statuses) throw new PayPalError('INVALID_STATUS', 400);
  const start = page(offset);
  const rows = await db.select().from(paypalWebhookInbox).where(and(kofiEvents, inArray(paypalWebhookInbox.status, statuses)))
    .orderBy(desc(paypalWebhookInbox.received_at), desc(paypalWebhookInbox.id)).limit(51).offset(start);
  const shown = rows.slice(0, 50);
  const key = shown.some((row) => retained(row.payload)) ? await existingKofiEmailHashKey() : null;
  const hashes = new Map<string, string>();
  for (const row of shown) {
    const email = retained(row.payload) ? normalizeKofiEmail((row.payload as Record<string, unknown>).email) : null;
    if (key && email) hashes.set(row.id, hashKofiEmail(key, email));
  }
  const wanted = [...new Set(hashes.values())];
  const members = wanted.length === 0 ? [] : await db.select({ hash: kofiMemberEmails.email_hash, userId: kofiMemberEmails.user_id,
    username: users.username }).from(kofiMemberEmails).innerJoin(users, eq(users.id, kofiMemberEmails.user_id))
    .where(inArray(kofiMemberEmails.email_hash, wanted));
  const items = shown.map((row) => {
    const kept = retained(row.payload);
    const event = kept ? row.payload as Record<string, unknown> : null;
    const open = row.status === 'needs_review' && kept;
    const member = members.find((item) => item.hash === hashes.get(row.id)) ?? null;
    return {
      id: row.id, eventType: row.event_type, status: row.status, reason: row.error_code,
      linkable: open && KOFI_LINKABLE_REASONS.includes(row.error_code ?? ''),
      settleable: open && row.error_code === KOFI_SETTLEABLE_REASON,
      receivedAt: row.received_at, eventAt: row.event_at, kofiTransactionId: row.resource_id || null, attemptCount: row.attempt_count,
      payloadRetained: kept,
      amount: event ? text(event.amount, 32) : null, currency: event ? text(event.currency, 8) : null,
      fromName: event ? text(event.from_name, 200) : null, email: event ? text(event.email, 254) : null,
      message: event ? text(event.message, 500) : null, tierName: event ? text(event.tier_name, 200) : null,
      isSubscriptionPayment: event ? event.is_subscription_payment === true : null,
      isFirstSubscriptionPayment: event ? event.is_first_subscription_payment === true : null,
      matchedUserId: member?.userId ?? null, matchedUsername: member?.username ?? null,
      resolution: row.resolution, resolvedAt: row.resolved_at,
    };
  });
  return { items, nextOffset: rows.length > 50 ? start + 50 : null };
}

async function lockReviewEvent(tx: DbOrTx, id: string): Promise<InboxRow> {
  const [entry] = await tx.select().from(paypalWebhookInbox).where(and(eq(paypalWebhookInbox.id, id), kofiEvents)).for('update');
  if (!entry || entry.status !== 'needs_review') throw new PayPalError('REVIEW_EVENT_NOT_FOUND', 404);
  return entry;
}
async function requireMember(tx: DbOrTx, userId: number | null) {
  if (userId === null) return;
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new PayPalError('USER_NOT_FOUND', 404);
}
/** Binds a payer email to a member. A no-op when it is already bound to that member. */
async function bindEmail(tx: DbOrTx, email: string, userId: number, actorId: number) {
  const hash = hashKofiEmail(await ensureKofiEmailHashKey(tx), email);
  const [existing] = await tx.select({ id: kofiMemberEmails.id, userId: kofiMemberEmails.user_id }).from(kofiMemberEmails)
    .where(eq(kofiMemberEmails.email_hash, hash)).limit(1);
  if (existing) {
    if (existing.userId !== userId) throw new PayPalError('EMAIL_ALREADY_LINKED', 409);
    return existing.id;
  }
  const [row] = await tx.insert(kofiMemberEmails).values({ user_id: userId, email_hash: hash, email_hint: kofiEmailHint(email),
    source: 'admin_link', verified_by: actorId }).returning({ id: kofiMemberEmails.id });
  return row.id;
}
async function resolveReviewEvent(tx: DbOrTx, id: string, actorId: number, resolution: 'linked' | 'settled') {
  const now = new Date();
  const claim = await tx.update(paypalWebhookInbox).set({ status: 'processed', processed_at: now, processing_at: null, next_attempt_at: null,
    resolution, resolved_by: actorId, resolved_at: now })
    .where(and(eq(paypalWebhookInbox.id, id), kofiEvents, eq(paypalWebhookInbox.status, 'needs_review')));
  if (claim.rowCount !== 1) throw new PayPalError('REVIEW_EVENT_NOT_FOUND', 404);
}
async function receiptIdFor(tx: DbOrTx, key: string): Promise<number> {
  const [row] = await tx.select({ id: paypalTransactions.id }).from(paypalTransactions)
    .where(and(kofiReceipts, eq(paypalTransactions.provider_transaction_id, key))).limit(1);
  if (!row) throw new PayPalError('KOFI_RECEIPT_NOT_FOUND', 404);
  return row.id;
}
// The only unique index these transactions can trip is the email hash: the
// ledger inserts all use ON CONFLICT DO NOTHING.
async function emailConflicts<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (err) { if (isUniqueViolation(err)) throw new PayPalError('EMAIL_ALREADY_LINKED', 409); throw err; }
}

/**
 * Accepts a DKK payment whose payer could not be matched. `userId: null`
 * records it without a member (a public Ko-fi page also takes non-members).
 * The receipt, the inbox resolution and the optional email binding commit
 * together; the receipt still waits for its fee.
 */
export async function linkKofiReviewEvent(id: unknown, input: any, actorId: number) {
  const eventId = kofiReviewId(id);
  const userId = memberId(input?.userId, true);
  const remember = input?.rememberEmail !== false;
  return emailConflicts(() => db.transaction(async (tx) => {
    const entry = await lockReviewEvent(tx, eventId);
    if (!KOFI_LINKABLE_REASONS.includes(entry.error_code ?? '') || !retained(entry.payload)) throw new PayPalError('REVIEW_EVENT_NOT_LINKABLE', 409);
    const verdict = await evaluateKofiEvent(tx, entry);
    if (verdict.verdict !== 'ok' || verdict.facts.foreign) throw new PayPalError('REVIEW_EVENT_NOT_LINKABLE', 409);
    await requireMember(tx, userId);
    if (remember && userId !== null && verdict.facts.email) await bindEmail(tx, verdict.facts.email, userId, actorId);
    await recordKofiReceipt(tx, verdict.facts, userId);
    await resolveReviewEvent(tx, eventId, actorId, 'linked');
    return { status: 'linked' as const, receiptId: await receiptIdFor(tx, verdict.facts.key) };
  }));
}

/**
 * Records a payment made in another currency at the DKK amount that actually
 * arrived. `grossDkk` is the amount before fees and `fee` the fee, both read
 * from the payout by the administrator; the app converts nothing. Posts gross
 * and fee at once, keeps what Ko-fi sent as the original amount, and can only
 * succeed once per event.
 */
export async function settleKofiReviewEvent(id: unknown, input: any, actorId: number) {
  const eventId = kofiReviewId(id);
  const userId = memberId(input?.userId, true);
  const grossOre = amountOre(input?.grossDkk);
  if (grossOre < 100 || grossOre > 1_000_000) throw new PayPalError('INVALID_AMOUNT', 400);
  const feeOre = amountOre(input?.fee);
  if (feeOre > grossOre) throw new PayPalError('FEE_OUT_OF_RANGE', 400);
  const note = optionalNote(input?.note);
  const remember = input?.rememberEmail !== false;
  return emailConflicts(() => db.transaction(async (tx) => {
    const entry = await lockReviewEvent(tx, eventId);
    if (entry.error_code !== KOFI_SETTLEABLE_REASON || !retained(entry.payload)) throw new PayPalError('REVIEW_EVENT_NOT_SETTLEABLE', 409);
    const verdict = await evaluateKofiEvent(tx, entry);
    if (verdict.verdict !== 'ok' || !verdict.facts.foreign) throw new PayPalError('REVIEW_EVENT_NOT_SETTLEABLE', 409);
    const { facts } = verdict;
    await requireMember(tx, userId);
    if (remember && userId !== null && facts.email) await bindEmail(tx, facts.email, userId, actorId);
    await postReceipt(scope(userId), facts.kind, { transactionId: facts.key, grossOre, feeOre, netOre: grossOre - feeOre,
      effectiveAt: facts.effectiveAt }, 'kofi_admin_settlement', tx);
    const receiptId = await receiptIdFor(tx, facts.key);
    await tx.update(paypalTransactions).set({ original_amount: facts.amount, original_currency: facts.currency, admin_note: note })
      .where(eq(paypalTransactions.id, receiptId));
    await resolveReviewEvent(tx, eventId, actorId, 'settled');
    return { status: 'settled' as const, receiptId, grossOre, feeOre, netOre: grossOre - feeOre };
  }));
}

/** Sends a review event back to the Ko-fi worker, for example after its email was linked. */
export async function retryKofiReviewEvent(id: unknown, actorId: number) {
  const eventId = kofiReviewId(id);
  const result = await db.update(paypalWebhookInbox).set({ status: 'pending', attempt_count: 0, next_attempt_at: null, processing_at: null,
    error_code: null, resolution: 'retried', resolved_by: actorId, resolved_at: new Date() })
    .where(and(eq(paypalWebhookInbox.id, eventId), kofiEvents, eq(paypalWebhookInbox.status, 'needs_review')));
  if (result.rowCount !== 1) throw new PayPalError('REVIEW_EVENT_NOT_FOUND', 404);
  return { status: 'pending' as const };
}

/** Records the event as not lab income. Posts nothing; the note is required. */
export async function dismissKofiReviewEvent(id: unknown, actorId: number, note: unknown) {
  return dismissPaypalReviewEvent(KOFI_ENVIRONMENT, kofiReviewId(id), actorId, note);
}

// ─── Receipts ────────────────────────────────────────────────────────────────

const RECEIPT_STATUSES = ['net_unresolved', 'posted', 'reversed', 'voided'];
const kindLabel = (kind: string) => (kind === 'kofi_subscription' ? 'subscription' : 'donation');

export async function listKofiReceipts(status: unknown = 'net_unresolved', offset: unknown = 0) {
  const statuses = status === 'all' ? RECEIPT_STATUSES : typeof status === 'string' && RECEIPT_STATUSES.includes(status) ? [status] : null;
  if (!statuses) throw new PayPalError('INVALID_STATUS', 400);
  const start = page(offset);
  const rows = await db.select({ id: paypalTransactions.id, transactionRef: paypalTransactions.provider_transaction_id,
    kind: paypalTransactions.provider_kind, status: paypalTransactions.status, userId: paypalTransactions.user_id, username: users.username,
    grossOre: paypalTransactions.gross_ore, feeOre: paypalTransactions.fee_ore, netOre: paypalTransactions.net_ore,
    effectiveAt: paypalTransactions.effective_at, observedAt: paypalTransactions.observed_at, note: paypalTransactions.admin_note,
    originalAmount: paypalTransactions.original_amount, originalCurrency: paypalTransactions.original_currency })
    .from(paypalTransactions).leftJoin(users, eq(users.id, paypalTransactions.user_id))
    .where(and(kofiReceipts, inArray(paypalTransactions.status, statuses)))
    .orderBy(desc(paypalTransactions.effective_at), desc(paypalTransactions.id)).limit(51).offset(start);
  return { items: rows.slice(0, 50).map((row) => ({ ...row, kind: kindLabel(row.kind) })), nextOffset: rows.length > 50 ? start + 50 : null };
}

async function lockReceipt(tx: DbOrTx, id: number): Promise<TransactionRow> {
  const [row] = await tx.select().from(paypalTransactions).where(and(eq(paypalTransactions.id, id), kofiReceipts)).for('update');
  if (!row || row.gross_ore === null || row.effective_at === null) throw new PayPalError('KOFI_RECEIPT_NOT_FOUND', 404);
  return row;
}

/**
 * Enters the actual fee for a receipt and posts its gross and fee, exactly
 * once. Zero is allowed as an explicit statement; an unknown fee stays
 * unknown until someone enters it.
 */
export async function resolveKofiReceiptFee(id: unknown, input: any) {
  const receiptId = kofiRowId(id);
  const feeOre = amountOre(input?.fee);
  const note = optionalNote(input?.note);
  return db.transaction(async (tx) => {
    const row = await lockReceipt(tx, receiptId);
    if (row.status !== 'net_unresolved') throw new PayPalError('KOFI_RECEIPT_NOT_UNRESOLVED', 409);
    const grossOre = row.gross_ore!;
    if (feeOre > grossOre) throw new PayPalError('FEE_OUT_OF_RANGE', 400);
    await postReceipt(scope(row.user_id), row.provider_kind as ReceiptKind, { transactionId: row.provider_transaction_id, grossOre, feeOre,
      netOre: grossOre - feeOre, effectiveAt: row.effective_at! }, 'kofi_admin_fee', tx);
    if (note) await tx.update(paypalTransactions).set({ admin_note: note }).where(eq(paypalTransactions.id, receiptId));
    return { id: receiptId, status: 'posted' as const, grossOre, feeOre, netOre: grossOre - feeOre };
  });
}

/**
 * Corrects a receipt. A posted receipt gets linked negative postings (the
 * original postings are never changed); one still waiting for its fee never
 * entered the ledger, so it is only marked voided.
 */
export async function reverseKofiReceipt(id: unknown, input: any) {
  const receiptId = kofiRowId(id);
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) throw new PayPalError('REASON_REQUIRED', 400);
  const feeCreditOre = input?.feeCredit === undefined || input?.feeCredit === null || input?.feeCredit === '' ? 0 : amountOre(input.feeCredit);
  return db.transaction(async (tx) => {
    const row = await lockReceipt(tx, receiptId);
    if (row.status === 'reversed' || row.status === 'voided') throw new PayPalError('KOFI_RECEIPT_ALREADY_REVERSED', 409);
    const noteWith = (label: string) => [row.admin_note, `${label}: ${reason}`].filter(Boolean).join('\n');
    if (row.status === 'net_unresolved') {
      await tx.update(paypalTransactions).set({ status: 'voided', admin_note: noteWith('Voided') }).where(eq(paypalTransactions.id, receiptId));
      return { id: receiptId, status: 'voided' as const };
    }
    if (row.status !== 'posted') throw new PayPalError('KOFI_RECEIPT_NOT_FOUND', 404);
    if (feeCreditOre > (row.fee_ore ?? 0)) throw new PayPalError('FEE_OUT_OF_RANGE', 400);
    const grossOre = row.gross_ore!;
    await postProviderAdjustment(scope(row.user_id), row.provider_transaction_id, row.provider_kind as ReceiptKind, 'reversal',
      { transactionId: `${row.provider_transaction_id}:reversal`, grossOre, feeCreditOre, netDebitOre: grossOre - feeCreditOre,
        effectiveAt: new Date() }, 'kofi_admin_reversal', tx);
    await tx.update(paypalTransactions).set({ status: 'reversed', admin_note: noteWith('Reversed') }).where(eq(paypalTransactions.id, receiptId));
    return { id: receiptId, status: 'reversed' as const };
  });
}

/** A member's own Ko-fi payments, with a status they can understand. */
export async function ownKofiReceipts(userId: number) {
  const rows = await db.select({ kind: paypalTransactions.provider_kind, amountOre: paypalTransactions.gross_ore,
    receivedAt: paypalTransactions.effective_at, status: paypalTransactions.status }).from(paypalTransactions)
    .where(and(kofiReceipts, eq(paypalTransactions.user_id, userId)))
    .orderBy(desc(paypalTransactions.effective_at), desc(paypalTransactions.id)).limit(50);
  const label: Record<string, string> = { net_unresolved: 'awaiting_fee', posted: 'counted', reversed: 'reversed', voided: 'voided' };
  return rows.map((row) => ({ kind: kindLabel(row.kind), amountOre: row.amountOre, receivedAt: row.receivedAt, status: label[row.status] ?? row.status }));
}

// ─── Linked emails ───────────────────────────────────────────────────────────

const memberEmailColumns = { id: kofiMemberEmails.id, userId: kofiMemberEmails.user_id, username: users.username,
  emailHint: kofiMemberEmails.email_hint, source: kofiMemberEmails.source, verifiedAt: kofiMemberEmails.verified_at };

export async function listKofiMemberEmails() {
  const items = await db.select(memberEmailColumns).from(kofiMemberEmails).innerJoin(users, eq(users.id, kofiMemberEmails.user_id))
    .orderBy(desc(kofiMemberEmails.verified_at), desc(kofiMemberEmails.id)).limit(200);
  return { items };
}

/** Binds an email to a member ahead of their first payment, so that payment matches by itself. */
export async function addKofiMemberEmail(input: any, actorId: number) {
  const userId = memberId(input?.userId, false)!;
  const email = normalizeKofiEmail(input?.email);
  if (!email) throw new PayPalError('INVALID_EMAIL', 400);
  return emailConflicts(() => db.transaction(async (tx) => {
    await requireMember(tx, userId);
    const hash = hashKofiEmail(await ensureKofiEmailHashKey(tx), email);
    const [taken] = await tx.select({ id: kofiMemberEmails.id }).from(kofiMemberEmails).where(eq(kofiMemberEmails.email_hash, hash)).limit(1);
    if (taken) throw new PayPalError('EMAIL_ALREADY_LINKED', 409);
    const [created] = await tx.insert(kofiMemberEmails).values({ user_id: userId, email_hash: hash, email_hint: kofiEmailHint(email),
      source: 'admin_entry', verified_by: actorId }).returning({ id: kofiMemberEmails.id });
    const [item] = await tx.select(memberEmailColumns).from(kofiMemberEmails).innerJoin(users, eq(users.id, kofiMemberEmails.user_id))
      .where(eq(kofiMemberEmails.id, created.id)).limit(1);
    return item;
  }));
}

export async function removeKofiMemberEmail(id: unknown) {
  const rowId = kofiRowId(id);
  const result = await db.delete(kofiMemberEmails).where(eq(kofiMemberEmails.id, rowId));
  if (result.rowCount !== 1) throw new PayPalError('MEMBER_EMAIL_NOT_FOUND', 404);
  return { removed: true as const };
}
