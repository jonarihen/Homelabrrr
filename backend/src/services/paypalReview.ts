import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { paypalWebhookInbox } from '../db/schema/index.ts';
import { PayPalError } from './paypalClient.ts';

// Operator resolution for quarantined (needs_review) webhook events. A review
// event blocks finalized net support until it is either retried through the
// normal verified ingestion path or explicitly dismissed with a note. A
// dismissal never posts money; it records that the event is not lab income
// (for example an unrelated account payment).

const ID_PATTERN = /^(sandbox|live):[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/;
function reviewId(environment: string, id: unknown) {
  if (environment !== 'sandbox' && environment !== 'live') throw new PayPalError('INVALID_ENVIRONMENT', 400);
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || !id.startsWith(`${environment}:`)) throw new PayPalError('INVALID_ID', 400);
  return id;
}

export async function listPaypalReviewEvents(environment: unknown, offset = 0, status: unknown = 'needs_review') {
  if (environment !== 'sandbox' && environment !== 'live') throw new PayPalError('INVALID_ENVIRONMENT', 400);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new PayPalError('INVALID_OFFSET', 400);
  const statuses = status === 'resolved' ? ['dismissed'] : status === 'all' ? ['needs_review', 'dismissed'] : ['needs_review'];
  // Never return the raw payload: it can contain payer data.
  const rows = await db.select({ id: paypalWebhookInbox.id, eventType: paypalWebhookInbox.event_type, status: paypalWebhookInbox.status,
    errorCode: paypalWebhookInbox.error_code, resourceId: paypalWebhookInbox.resource_id, source: paypalWebhookInbox.source,
    receivedAt: paypalWebhookInbox.received_at, eventAt: paypalWebhookInbox.event_at, attemptCount: paypalWebhookInbox.attempt_count,
    resolution: paypalWebhookInbox.resolution, resolvedAt: paypalWebhookInbox.resolved_at })
    .from(paypalWebhookInbox).where(and(eq(paypalWebhookInbox.environment, environment), inArray(paypalWebhookInbox.status, statuses)))
    .orderBy(desc(paypalWebhookInbox.received_at), desc(paypalWebhookInbox.id)).limit(51).offset(offset);
  return { environment, items: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
}

/** Requeue a review event through the normal verified processing path. */
export async function retryPaypalReviewEvent(environment: string, id: unknown, actorId: number) {
  const key = reviewId(environment, id);
  const result = await db.update(paypalWebhookInbox).set({ status: 'pending', attempt_count: 0, next_attempt_at: null, processing_at: null,
    error_code: null, resolution: 'retried', resolved_by: actorId, resolved_at: new Date() })
    .where(and(eq(paypalWebhookInbox.id, key), eq(paypalWebhookInbox.environment, environment), eq(paypalWebhookInbox.status, 'needs_review')));
  if (result.rowCount !== 1) throw new PayPalError('REVIEW_EVENT_NOT_FOUND', 404);
  return { status: 'pending' };
}

/** Dismiss a review event as not lab income. The note is required. */
export async function dismissPaypalReviewEvent(environment: string, id: unknown, actorId: number, note: unknown) {
  const key = reviewId(environment, id);
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length < 3 || text.length > 500) throw new PayPalError('REVIEW_NOTE_REQUIRED', 400);
  const now = new Date();
  const result = await db.update(paypalWebhookInbox).set({ status: 'dismissed', resolution: 'dismissed', resolution_note: text,
    resolved_by: actorId, resolved_at: now, processed_at: now, next_attempt_at: null, processing_at: null })
    .where(and(eq(paypalWebhookInbox.id, key), eq(paypalWebhookInbox.environment, environment), eq(paypalWebhookInbox.status, 'needs_review')));
  if (result.rowCount !== 1) throw new PayPalError('REVIEW_EVENT_NOT_FOUND', 404);
  return { status: 'dismissed' };
}
