import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { kofiConfig, kofiMemberEmails, manualContributions, paypalTransactions, paypalWebhookInbox } from '../db/schema/index.ts';
import { decryptSecret, encryptSecret } from '../utils/secrets.ts';
import { log } from '../utils/logger.ts';
import { incrementMetric } from '../utils/metricRegistry.ts';
import { PayPalError } from './paypalClient.ts';
import { postReceipt } from './paypalLedger.ts';

// Ko-fi support: configuration, the public ingress and the inbox worker.
//
// Ko-fi is live only and uses the merchant scope `kofi`. Events are stored in
// the shared provider inbox (id `live:kofi:<message_id>`), accepted payments
// become paypal_transactions rows and reach paypal_postings only once an
// administrator has entered the actual fee, so a missing fee is never treated
// as zero. Ko-fi sends a static verification token inside the body rather than
// a signature: it is compared in constant time and never stored, logged or
// returned.

export const KOFI_ENVIRONMENT = 'live';
export const KOFI_MERCHANT = 'kofi';
export const KOFI_INBOX_SOURCE = 'kofi_webhook';
export const KOFI_RECEIPT_KINDS = ['kofi_donation', 'kofi_subscription'] as const;
export type KofiReceiptKind = (typeof KOFI_RECEIPT_KINDS)[number];
// The transaction id of Ko-fi's own "send test" buttons. Such an event proves
// the URL and token work; it is acknowledged and ignored.
export const KOFI_TEST_TRANSACTION_ID = '00000000-1111-2222-3333-444444444444';
export const KOFI_LINKABLE_REASONS = ['EMAIL_MISSING', 'MEMBER_UNMATCHED'];
export const KOFI_SETTLEABLE_REASON = 'CURRENCY_NOT_DKK';
// Outcomes stored in error_code on a processed row that are not errors.
export const KOFI_IGNORED_CODES = ['TEST_EVENT', 'DUPLICATE_TRANSACTION'];
const MAX_ATTEMPTS = 5;
const DAY_MS = 86_400_000;

type InboxRow = typeof paypalWebhookInbox.$inferSelect;
type ConfigRow = typeof kofiConfig.$inferSelect;

// ─── Pure helpers ────────────────────────────────────────────────────────────

const DECIMAL = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/;
/** Decimal string to minor units (øre for DKK) without going through a float. */
export function decimalToMinorUnits(value: unknown): number | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Same normalization as manual reference keys, so the manual duplicate guard matches. */
export function kofiTransactionKey(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value)) return null;
  const key = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key.length >= 8 ? key : null;
}

export function normalizeKofiEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) return null;
  return email;
}

/** Masked form shown to administrators, e.g. `an…@example.dk`. */
export function kofiEmailHint(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  return `${local.slice(0, local.length <= 2 ? 1 : 2)}…${email.slice(at)}`;
}

export function hashKofiEmail(key: Buffer, email: string): string {
  return createHmac('sha256', key).update(email, 'utf8').digest('hex');
}

/** Only a Ko-fi page URL is accepted; stored as `https://ko-fi.com/<handle>`. */
export function normalizeKofiPageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || !['ko-fi.com', 'www.ko-fi.com'].includes(url.hostname) || url.port ||
      url.username || url.password || url.search || url.hash) return null;
  const match = /^\/([A-Za-z0-9_]{1,64})\/?$/.exec(url.pathname);
  return match ? `https://ko-fi.com/${match[1]}` : null;
}

/**
 * Constant-time, length-independent comparison. Both sides are hashed first,
 * and a comparison always runs, so a missing or short token costs the same as
 * a wrong one.
 */
export function kofiTokenMatches(presented: unknown, stored: string | null | undefined): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  const candidate = typeof presented === 'string' ? presented : '';
  const expected = typeof stored === 'string' && stored ? stored : randomBytes(32).toString('hex');
  const equal = timingSafeEqual(digest(candidate), digest(expected));
  return equal && candidate.length > 0 && typeof stored === 'string' && stored.length > 0;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;
/** Ko-fi sends UTC ISO-8601; a value without a zone is read as UTC. */
export function parseKofiTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = ISO_TIME.exec(value);
  if (!match) return null;
  const date = new Date(match[1] ? value : `${value}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export type KofiEventFacts = {
  kind: KofiReceiptKind;
  /** Normalized Ko-fi transaction id: the economic reference. */
  key: string;
  currency: string;
  foreign: boolean;
  /** Amount exactly as Ko-fi sent it. */
  amount: string;
  minorUnits: number;
  /** DKK gross in øre; null for a payment in another currency. */
  grossOre: number | null;
  effectiveAt: Date;
  /** Normalized payer email, or null when missing or invalid. */
  email: string | null;
};
export type KofiVerdict =
  | { verdict: 'ignored'; code: string }
  | { verdict: 'review'; code: string }
  | { verdict: 'ok'; facts: KofiEventFacts };
const review = (code: string): KofiVerdict => ({ verdict: 'review', code });

/** Rules 1–7: everything that can be decided from the event alone. */
export function classifyKofiPayload(payload: unknown, receivedAt: Date): KofiVerdict {
  const event: Record<string, unknown> = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (event.kofi_transaction_id === KOFI_TEST_TRANSACTION_ID) return { verdict: 'ignored', code: 'TEST_EVENT' };
  if (event.type === 'Commission' || event.type === 'Shop Order') return review('UNSUPPORTED_TYPE');
  if (event.type !== 'Donation' && event.type !== 'Subscription') return review('UNKNOWN_TYPE');
  if (typeof event.currency !== 'string' || !/^[A-Z]{3}$/.test(event.currency)) return review('INVALID_CURRENCY');
  const foreign = event.currency !== 'DKK';
  // A JSON number is refused: money never passes through a float.
  const minorUnits = decimalToMinorUnits(event.amount);
  if (minorUnits === null || (foreign ? minorUnits < 1 || minorUnits > 10_000_000 : minorUnits < 100 || minorUnits > 1_000_000))
    return review('INVALID_AMOUNT');
  const key = kofiTransactionKey(event.kofi_transaction_id);
  if (!key) return review('INVALID_TRANSACTION_ID');
  const effectiveAt = parseKofiTimestamp(event.timestamp);
  if (!effectiveAt || effectiveAt.getTime() > receivedAt.getTime() + DAY_MS || effectiveAt.getTime() < receivedAt.getTime() - 400 * DAY_MS)
    return review('INVALID_TIMESTAMP');
  return { verdict: 'ok', facts: { kind: event.type === 'Donation' ? 'kofi_donation' : 'kofi_subscription', key,
    currency: event.currency, foreign, amount: event.amount as string, minorUnits, grossOre: foreign ? null : minorUnits,
    effectiveAt, email: normalizeKofiEmail(event.email) } };
}

/** Rules 1–10: adds the duplicate checks against manual receipts and recorded receipts. */
export async function evaluateKofiEvent(database: DbOrTx, entry: Pick<InboxRow, 'payload' | 'received_at'>): Promise<KofiVerdict> {
  const base = classifyKofiPayload(entry.payload, entry.received_at);
  if (base.verdict !== 'ok') return base;
  const { facts } = base;
  // The same money already entered the ledger as a confirmed or pending manual receipt.
  const [manual] = await database.select({ id: manualContributions.id }).from(manualContributions)
    .where(and(eq(manualContributions.reference_key, facts.key), ne(manualContributions.status, 'rejected'))).limit(1);
  if (manual) return review('DUPLICATE_MANUAL_RECEIPT');
  const [existing] = await database.select().from(paypalTransactions).where(and(eq(paypalTransactions.environment, KOFI_ENVIRONMENT),
    eq(paypalTransactions.merchant_id, KOFI_MERCHANT), eq(paypalTransactions.provider_transaction_id, facts.key))).limit(1);
  if (existing) {
    const same = existing.provider_kind === facts.kind && (facts.foreign
      ? existing.original_currency === facts.currency && decimalToMinorUnits(existing.original_amount) === facts.minorUnits
      : existing.original_currency === null && existing.gross_ore === facts.grossOre);
    return same ? { verdict: 'ignored', code: 'DUPLICATE_TRANSACTION' } : review('TRANSACTION_CONFLICT');
  }
  return base;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export async function kofiConfigRow(database: DbOrTx = db): Promise<ConfigRow | undefined> {
  const [row] = await database.select().from(kofiConfig).where(eq(kofiConfig.id, 1)).limit(1);
  return row;
}

/** What a signed-in member may know: whether Ko-fi is on, and the page link. */
export async function memberKofiStatus() {
  const row = await kofiConfigRow();
  const enabled = row?.enabled === true && Boolean(row.page_url);
  return { enabled, pageUrl: enabled ? row!.page_url : null };
}

/**
 * Saves the page URL and, when given, replaces the verification token. The
 * token is write-only: leaving it out keeps the stored one. Saving never
 * changes whether the integration is enabled.
 */
export async function saveKofiConfiguration(input: any, actorId: number | null = null) {
  const pageUrl = normalizeKofiPageUrl(input?.pageUrl);
  if (!pageUrl) throw new PayPalError('INVALID_PAGE_URL', 400);
  const token = input?.verificationToken;
  const replace = token !== undefined && token !== null && token !== '';
  if (replace && (typeof token !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(token))) throw new PayPalError('INVALID_TOKEN_FORMAT', 400);
  const now = new Date();
  const values = { page_url: pageUrl, updated_by: actorId, updated_at: now,
    ...(replace ? { verification_token: encryptSecret(token as string), token_updated_at: now } : {}) };
  await db.insert(kofiConfig).values({ id: 1, ...values }).onConflictDoUpdate({ target: kofiConfig.id, set: values });
  return { tokenReplaced: replace };
}

export async function setKofiEnabled(enabled: boolean, actorId: number | null = null) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(kofiConfig).where(eq(kofiConfig.id, 1)).for('update');
    if (enabled && (!row?.verification_token || !row.page_url)) throw new PayPalError('KOFI_NOT_CONFIGURED', 409);
    if (!row) return;
    await tx.update(kofiConfig).set({ enabled, updated_by: actorId, updated_at: new Date() }).where(eq(kofiConfig.id, 1));
  });
}

/** The webhook URL to paste into Ko-fi, from the configured portal origin. */
export function kofiWebhookUrl(): { url: string | null; error: string | null } {
  const configured = process.env.PORTAL_BASE_URL || process.env.ALLOWED_ORIGIN;
  let base: URL;
  try { base = new URL(configured || ''); } catch { return { url: null, error: 'RETURN_ORIGIN_NOT_CONFIGURED' }; }
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    return { url: null, error: 'WEBHOOK_ORIGIN_INVALID' };
  return { url: `${base.origin}/api/payments/kofi/webhook`, error: null };
}

/**
 * The install-specific key used to hash payer emails. Created on first use.
 * Call inside a transaction: the row lock keeps two creators from racing.
 */
export async function ensureKofiEmailHashKey(tx: DbOrTx): Promise<Buffer> {
  await tx.insert(kofiConfig).values({ id: 1 }).onConflictDoNothing();
  const [row] = await tx.select({ key: kofiConfig.email_hash_key }).from(kofiConfig).where(eq(kofiConfig.id, 1)).for('update');
  if (row?.key) return Buffer.from(decryptSecret(row.key), 'hex');
  const hex = randomBytes(32).toString('hex');
  await tx.update(kofiConfig).set({ email_hash_key: encryptSecret(hex) }).where(eq(kofiConfig.id, 1));
  return Buffer.from(hex, 'hex');
}

/** The hash key if one exists. Without a key there are no linked emails yet. */
export async function existingKofiEmailHashKey(database: DbOrTx = db): Promise<Buffer | null> {
  const [row] = await database.select({ key: kofiConfig.email_hash_key }).from(kofiConfig).where(eq(kofiConfig.id, 1)).limit(1);
  return row?.key ? Buffer.from(decryptSecret(row.key), 'hex') : null;
}

/** The member a payer email is bound to, if any. The unique hash allows at most one. */
export async function matchKofiMember(database: DbOrTx, email: string | null): Promise<{ id: number; userId: number } | null> {
  if (!email) return null;
  const key = await existingKofiEmailHashKey(database);
  if (!key) return null;
  const [row] = await database.select({ id: kofiMemberEmails.id, userId: kofiMemberEmails.user_id }).from(kofiMemberEmails)
    .where(eq(kofiMemberEmails.email_hash, hashKofiEmail(key, email))).limit(1);
  return row ?? null;
}

// ─── Public ingress ──────────────────────────────────────────────────────────

type RejectionCode = 'MALFORMED' | 'INVALID_TOKEN' | 'DISABLED';
const rejectionWrites = new Map<RejectionCode, number>();
/**
 * Remembers the last refused delivery for the admin status panel. Callers are
 * unauthenticated, so each reason is written at most once a minute. A failure
 * here never changes the response.
 */
export async function recordKofiRejection(code: RejectionCode, now = Date.now()) {
  if (now - (rejectionWrites.get(code) ?? 0) < 60_000) return;
  rejectionWrites.set(code, now);
  try {
    await db.update(kofiConfig).set({ last_rejected_at: new Date(now), last_rejected_code: code }).where(eq(kofiConfig.id, 1));
  } catch { /* status telemetry only */ }
}
async function reject(code: RejectionCode, status: number): Promise<never> {
  await recordKofiRejection(code);
  incrementMetric('kofi_webhook_rejected', `reason="${code}"`);
  throw new PayPalError(code, status);
}

// Defence in depth: besides dropping the documented field, the token survives
// nowhere in the stored payload, not as a value, inside a longer string or as
// a key. Ko-fi's payload is at most three levels deep; anything nested deeper
// than eight levels is not stored at all.
function withoutToken(value: unknown, token: string, depth = 0): unknown {
  const scrub = (text: string) => (text.includes(token) ? text.split(token).join('[removed]') : text);
  if (typeof value === 'string') return scrub(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => withoutToken(item, token, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [scrub(name), withoutToken(item, token, depth + 1)]));
}

/**
 * Verifies and durably stores one Ko-fi delivery. `data` is the form field
 * Ko-fi posts: a JSON object as a string. Throws a PayPalError carrying the
 * HTTP status for every refusal; nothing is stored unless the token matched
 * and the integration is enabled. Returns after the insert has committed.
 */
export async function storeKofiWebhook(data: unknown): Promise<{ stored: boolean }> {
  let event: Record<string, unknown> | null = null;
  if (typeof data === 'string' && data.length <= 64 * 1024) {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) event = parsed;
    } catch { /* refused below */ }
  }
  if (!event) return reject('MALFORMED', 400);
  const config = await kofiConfigRow();
  const token = config?.verification_token ? decryptSecret(config.verification_token) : null;
  if (!kofiTokenMatches(event.verification_token, token)) return reject('INVALID_TOKEN', 401);
  if (!config!.enabled) return reject('DISABLED', 503);
  if (typeof event.message_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.message_id)) return reject('MALFORMED', 400);
  // The token and the postal address never reach the database.
  const { verification_token: _token, shipping: _shipping, ...rest } = event;
  const payload = withoutToken(rest, token!) as Record<string, unknown>;
  const inserted = await db.insert(paypalWebhookInbox).values({
    id: `${KOFI_ENVIRONMENT}:${KOFI_MERCHANT}:${event.message_id}`, environment: KOFI_ENVIRONMENT, merchant_id: KOFI_MERCHANT,
    event_type: typeof event.type === 'string' ? event.type.slice(0, 64) : '',
    resource_id: typeof event.kofi_transaction_id === 'string' ? event.kofi_transaction_id.slice(0, 128) : null,
    payload, source: KOFI_INBOX_SOURCE, event_at: parseKofiTimestamp(event.timestamp),
  }).onConflictDoNothing().returning({ id: paypalWebhookInbox.id });
  return { stored: inserted.length === 1 };
}

// ─── Inbox worker ────────────────────────────────────────────────────────────

/** Records an accepted DKK payment: gross only, net unknown until the fee is entered. */
export async function recordKofiReceipt(tx: DbOrTx, facts: KofiEventFacts, userId: number | null) {
  if (facts.grossOre === null) throw new PayPalError('INVALID_RECEIPT');
  return postReceipt({ environment: KOFI_ENVIRONMENT, merchantId: KOFI_MERCHANT, intentId: null, userId }, facts.kind,
    { transactionId: facts.key, grossOre: facts.grossOre, feeOre: null, netOre: null, effectiveAt: facts.effectiveAt }, 'kofi_webhook', tx);
}

type Outcome = { outcome: 'recorded' | 'ignored' | 'review'; code: string | null };
async function decide(tx: DbOrTx, entry: InboxRow): Promise<Outcome> {
  const verdict = await evaluateKofiEvent(tx, entry);
  if (verdict.verdict === 'ignored') return { outcome: 'ignored', code: verdict.code };
  if (verdict.verdict === 'review') return { outcome: 'review', code: verdict.code };
  // Another currency is never converted or recorded automatically: the
  // administrator records the DKK amount that actually arrived.
  if (verdict.facts.foreign) return { outcome: 'review', code: KOFI_SETTLEABLE_REASON };
  if (!verdict.facts.email) return { outcome: 'review', code: 'EMAIL_MISSING' };
  const member = await matchKofiMember(tx, verdict.facts.email);
  if (!member) return { outcome: 'review', code: 'MEMBER_UNMATCHED' };
  await recordKofiReceipt(tx, verdict.facts, member.userId);
  return { outcome: 'recorded', code: null };
}

const KNOWN_TYPES = new Set(['Donation', 'Subscription', 'Commission', 'Shop Order']);
// Fixed vocabulary only: no ids, amounts or payer data reach logs or metrics.
function report(entry: InboxRow, outcome: string, code: string | null) {
  const type = KNOWN_TYPES.has(entry.event_type) ? entry.event_type : 'OTHER';
  incrementMetric('kofi_webhook_events', `type="${type}",outcome="${outcome}"`);
  if (outcome === 'recorded') return;
  log(outcome === 'failed' ? 'warn' : 'info', 'kofi_webhook_event_not_recorded', { type, outcome,
    ...(code ? { code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'OTHER' } : {}) });
}

export function kofiInboxRetryDelayMs(attempt: number) {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, Math.min(attempt - 1, 10)));
}

/**
 * Processes pending Ko-fi events. Each event is claimed atomically, and its
 * receipt and its inbox status commit in one transaction, so a crash or a
 * concurrent worker can never record the same payment twice. Old payloads are
 * emptied by the shared inbox prune job (30 days after processing).
 */
export async function processKofiInbox(limit = 20) {
  await db.update(paypalWebhookInbox).set({ status: 'pending', processing_at: null })
    .where(and(eq(paypalWebhookInbox.source, KOFI_INBOX_SOURCE), eq(paypalWebhookInbox.status, 'processing'),
      lt(paypalWebhookInbox.processing_at, new Date(Date.now() - 10 * 60_000))));
  const pending = await db.select().from(paypalWebhookInbox).where(and(eq(paypalWebhookInbox.source, KOFI_INBOX_SOURCE),
    eq(paypalWebhookInbox.status, 'pending'), or(isNull(paypalWebhookInbox.next_attempt_at), lte(paypalWebhookInbox.next_attempt_at, new Date()))))
    .orderBy(paypalWebhookInbox.received_at).limit(Math.max(1, Math.min(limit, 50)));
  for (const entry of pending) {
    const attempt = entry.attempt_count + 1;
    const claim = await db.update(paypalWebhookInbox).set({ status: 'processing', processing_at: new Date(), attempt_count: attempt })
      .where(and(eq(paypalWebhookInbox.id, entry.id), eq(paypalWebhookInbox.status, 'pending')));
    if (claim.rowCount !== 1) continue;
    const mine = and(eq(paypalWebhookInbox.id, entry.id), eq(paypalWebhookInbox.status, 'processing'));
    try {
      const result = await db.transaction(async (tx) => {
        const decided = await decide(tx, entry);
        const done = decided.outcome !== 'review';
        const saved = await tx.update(paypalWebhookInbox).set({ status: done ? 'processed' : 'needs_review', error_code: decided.code,
          processing_at: null, next_attempt_at: null, ...(done ? { processed_at: new Date() } : {}) }).where(mine);
        if (saved.rowCount !== 1) throw new Error('Ko-fi inbox claim was lost');
        return decided;
      });
      report(entry, result.outcome, result.code);
    } catch (err) {
      // A different amount or kind under an already recorded reference is a
      // matter for the operator, not for a retry.
      const conflict = err instanceof PayPalError && err.code === 'TRANSACTION_CONFLICT';
      const retry = !conflict && attempt < MAX_ATTEMPTS;
      const code = conflict ? 'TRANSACTION_CONFLICT' : 'PROCESSING_FAILED';
      report(entry, retry ? 'failed' : 'review', code);
      await db.update(paypalWebhookInbox).set({ status: retry ? 'pending' : 'needs_review', error_code: code, processing_at: null,
        next_attempt_at: retry ? new Date(Date.now() + kofiInboxRetryDelayMs(attempt)) : null }).where(mine);
    }
  }
}

let inboxTimer: NodeJS.Timeout | null = null;
export function startKofiInboxWorker() {
  if (inboxTimer) return;
  inboxTimer = setInterval(() => { void processKofiInbox().catch(() => {}); }, 60_000);
  inboxTimer.unref();
  void processKofiInbox().catch(() => {});
}
export function stopKofiInboxWorker() { if (inboxTimer) clearInterval(inboxTimer); inboxTimer = null; }
