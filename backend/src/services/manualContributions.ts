import { and, count, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { manualContributions, paypalPostings, paypalTransactions } from '../db/schema/index.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { PayPalError } from './paypalClient.ts';
import { startOfLocalDateUtc } from './energyAccounting.ts';

// Manual bank-transfer fallback. Reports are evidence only. Confirmation is an
// administrator decision with an evidence reference and posts exactly one
// append-only live DKK receipt under the dedicated `manual` merchant scope, so
// it flows into the same ledger, snapshot and allocation as PayPal receipts.
// Reversal appends a linked negative posting; nothing is deleted.

export const MANUAL_MERCHANT = 'manual';
const MAX_OPEN_REPORTS = 5;

export function manualReferenceKey(value: unknown) {
  if (typeof value !== 'string' || value.length > 128 || !/^[\x20-\x7e]+$/.test(value)) throw new PayPalError('INVALID_REFERENCE', 400);
  const key = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key.length < 4 || key.length > 64) throw new PayPalError('INVALID_REFERENCE', 400);
  return key;
}
export function parseManualOre(value: unknown) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) throw new PayPalError('INVALID_AMOUNT', 400);
  const [whole, fraction = ''] = value.split('.');
  const ore = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (ore < 100 || ore > 1_000_000) throw new PayPalError('AMOUNT_OUT_OF_RANGE', 400);
  return ore;
}
function receivedAt(value: unknown, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) throw new PayPalError('INVALID_DATE', 400);
  const date = startOfLocalDateUtc(value);
  if (!Number.isFinite(date.getTime()) || date > now || date.getTime() < now.getTime() - 400 * 86_400_000) throw new PayPalError('INVALID_DATE', 400);
  return date;
}
function text(value: unknown, min: number, max: number, code: string) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < min || trimmed.length > max) throw new PayPalError(code, 400);
  return trimmed || null;
}

// A reference that is an imported PayPal transaction ID is not a bank
// transfer: posting it manually would count the same money twice.
async function assertNotProviderPayment(tx: any, reference: string, key: string) {
  const [match] = await tx.select({ id: paypalTransactions.id }).from(paypalTransactions)
    .where(inArray(paypalTransactions.provider_transaction_id, [...new Set([reference.trim(), key])])).limit(1);
  if (match) throw new PayPalError('DUPLICATE_PROVIDER_PAYMENT', 409);
}

export async function reportManualContribution(userId: number, input: any) {
  const reference = String(input?.reference ?? '');
  const key = manualReferenceKey(reference);
  const amount = parseManualOre(input?.amount);
  const at = receivedAt(input?.receivedOn);
  const note = text(input?.note, 0, 500, 'INVALID_NOTE');
  try {
    return await db.transaction(async (tx) => {
      const [{ open }] = await tx.select({ open: count() }).from(manualContributions)
        .where(and(eq(manualContributions.user_id, userId), eq(manualContributions.status, 'reported')));
      if (open >= MAX_OPEN_REPORTS) throw new PayPalError('TOO_MANY_OPEN_REPORTS', 429);
      await assertNotProviderPayment(tx, reference, key);
      const [row] = await tx.insert(manualContributions).values({ user_id: userId, amount_ore: amount, reference: reference.trim(), reference_key: key,
        received_at: at, member_note: note, reported_by: userId }).returning({ id: manualContributions.id, status: manualContributions.status });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PayPalError('DUPLICATE_REFERENCE', 409);
    throw err;
  }
}

async function postConfirmation(tx: any, row: typeof manualContributions.$inferSelect, actorId: number, evidence: string, acknowledgeSimilar: boolean) {
  await assertNotProviderPayment(tx, row.reference, row.reference_key);
  if (row.user_id && !acknowledgeSimilar) {
    // Same member, same amount, near the same day, already imported from
    // PayPal: almost certainly the same money. Require an explicit override.
    const [similar] = await tx.select({ id: paypalPostings.id }).from(paypalPostings).where(and(eq(paypalPostings.environment, 'live'),
      eq(paypalPostings.user_id, row.user_id), eq(paypalPostings.posting_kind, 'gross'), eq(paypalPostings.amount_ore, row.amount_ore),
      gte(paypalPostings.effective_at, new Date(row.received_at.getTime() - 4 * 86_400_000)),
      lte(paypalPostings.effective_at, new Date(row.received_at.getTime() + 4 * 86_400_000)))).limit(1);
    if (similar) throw new PayPalError('SIMILAR_PROVIDER_PAYMENT', 409);
  }
  await tx.insert(paypalPostings).values({ environment: 'live', merchant_id: MANUAL_MERCHANT, provider_transaction_id: `manual:${row.reference_key}`,
    posting_kind: 'gross', source_id: `manual:${row.id}`, user_id: row.user_id, amount_ore: row.amount_ore, currency: 'DKK',
    effective_at: row.received_at, verification: 'manual_admin' });
  await tx.update(manualContributions).set({ status: 'confirmed', evidence, decided_by: actorId, decided_at: new Date() })
    .where(eq(manualContributions.id, row.id));
}

export async function confirmManualContribution(actorId: number, id: number, input: any) {
  const evidence = text(input?.evidence, 3, 500, 'EVIDENCE_REQUIRED')!;
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.select().from(manualContributions).where(eq(manualContributions.id, id)).for('update');
      if (!row) throw new PayPalError('MANUAL_NOT_FOUND', 404);
      if (row.status !== 'reported') throw new PayPalError('MANUAL_ALREADY_DECIDED', 409);
      await postConfirmation(tx, row, actorId, evidence, input?.acknowledgeSimilar === true);
      return { id, status: 'confirmed' };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PayPalError('DUPLICATE_REFERENCE', 409);
    throw err;
  }
}

/** Admin-recorded transfer (no member report), confirmed in one step. */
export async function recordManualContribution(actorId: number, input: any) {
  const reference = String(input?.reference ?? '');
  const key = manualReferenceKey(reference);
  const amount = parseManualOre(input?.amount);
  const at = receivedAt(input?.receivedOn);
  const evidence = text(input?.evidence, 3, 500, 'EVIDENCE_REQUIRED')!;
  const userId = input?.userId == null || input.userId === '' ? null : Number(input.userId);
  if (userId !== null && !Number.isSafeInteger(userId)) throw new PayPalError('INVALID_USER', 400);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(manualContributions).values({ user_id: userId, amount_ore: amount, reference: reference.trim(), reference_key: key,
        received_at: at, reported_by: actorId }).returning();
      await postConfirmation(tx, row, actorId, evidence, input?.acknowledgeSimilar === true);
      return { id: row.id, status: 'confirmed' };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PayPalError('DUPLICATE_REFERENCE', 409);
    throw err;
  }
}

export async function rejectManualContribution(actorId: number, id: number, input: any) {
  const reason = text(input?.reason, 3, 500, 'REASON_REQUIRED');
  const result = await db.update(manualContributions).set({ status: 'rejected', evidence: reason, decided_by: actorId, decided_at: new Date() })
    .where(and(eq(manualContributions.id, id), eq(manualContributions.status, 'reported')));
  if (result.rowCount !== 1) throw new PayPalError('MANUAL_NOT_FOUND', 404);
  return { id, status: 'rejected' };
}

/** Corrects a confirmed entry with a linked negative posting. */
export async function reverseManualContribution(actorId: number, id: number, input: any) {
  const reason = text(input?.reason, 3, 500, 'REASON_REQUIRED')!;
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(manualContributions).where(eq(manualContributions.id, id)).for('update');
    if (!row) throw new PayPalError('MANUAL_NOT_FOUND', 404);
    if (row.status !== 'confirmed') throw new PayPalError('MANUAL_NOT_CONFIRMED', 409);
    const now = new Date();
    await tx.insert(paypalPostings).values({ environment: 'live', merchant_id: MANUAL_MERCHANT, provider_transaction_id: `manual:${row.reference_key}:reversal`,
      posting_kind: 'reversal', source_id: `manual:${row.id}`, original_transaction_id: `manual:${row.reference_key}`, user_id: row.user_id,
      amount_ore: -row.amount_ore, currency: 'DKK', effective_at: now, verification: 'manual_admin' });
    await tx.update(manualContributions).set({ status: 'reversed', reversed_at: now, evidence: `${row.evidence ?? ''}\nReversed: ${reason}`.trim() })
      .where(eq(manualContributions.id, row.id));
    return { id, status: 'reversed' };
  });
}

export async function listManualContributions(status: unknown = 'reported', offset = 0) {
  const statuses = status === 'all' ? ['reported', 'confirmed', 'rejected', 'reversed'] : [String(status)];
  if (statuses.some((item) => !['reported', 'confirmed', 'rejected', 'reversed'].includes(item))) throw new PayPalError('INVALID_STATUS', 400);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new PayPalError('INVALID_OFFSET', 400);
  const rows = await db.select({ id: manualContributions.id, userId: manualContributions.user_id, amountOre: manualContributions.amount_ore,
    reference: manualContributions.reference, receivedAt: manualContributions.received_at, status: manualContributions.status,
    memberNote: manualContributions.member_note, evidence: manualContributions.evidence, reportedAt: manualContributions.reported_at,
    decidedAt: manualContributions.decided_at })
    .from(manualContributions).where(inArray(manualContributions.status, statuses))
    .orderBy(desc(manualContributions.reported_at), desc(manualContributions.id)).limit(51).offset(offset);
  return { items: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
}

export async function ownManualContributions(userId: number) {
  return db.select({ id: manualContributions.id, amountOre: manualContributions.amount_ore, reference: manualContributions.reference,
    receivedAt: manualContributions.received_at, status: manualContributions.status, reportedAt: manualContributions.reported_at })
    .from(manualContributions).where(eq(manualContributions.user_id, userId)).orderBy(desc(manualContributions.reported_at)).limit(50);
}
