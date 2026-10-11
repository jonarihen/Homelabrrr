import { sql } from 'drizzle-orm';
import { pgTable, integer, text, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './auth.ts';
import { electricityCostStatements } from './energy.ts';

// Environment and merchant form a hard accounting boundary. Secrets are encrypted.
export const paypalConfigs = pgTable('paypal_configs', {
  environment: text('environment').primaryKey(),
  client_id: text('client_id'),
  client_secret: text('client_secret'),
  merchant_id: text('merchant_id'),
  webhook_id: text('webhook_id'),
  monthly_plan_id: text('monthly_plan_id'),
  monthly_amount_ore: integer('monthly_amount_ore'),
  enabled: boolean('enabled').notNull().default(false),
  config_version: integer('config_version').notNull().default(1),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const paypalIntents = pgTable('paypal_intents', {
  id: text('id').primaryKey(),
  user_id: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  environment: text('environment').notNull(),
  merchant_id: text('merchant_id').notNull(),
  kind: text('kind').notNull(),
  amount_ore: integer('amount_ore').notNull(),
  currency: text('currency').notNull().default('DKK'),
  status: text('status').notNull().default('created'),
  provider_id: text('provider_id'),
  create_request_id: text('create_request_id').notNull(),
  capture_request_id: text('capture_request_id'),
  // Reconciliation-only capture retries for an approved order whose capture
  // outcome was lost; each retry reuses capture_request_id.
  capture_attempts: integer('capture_attempts').notNull().default(0),
  config_version: integer('config_version').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('paypal_intent_provider').on(t.environment, t.merchant_id, t.provider_id),
  uniqueIndex('paypal_intent_create_request').on(t.create_request_id),
  index('paypal_intent_user_created').on(t.user_id, t.created_at),
]);

export const paypalSubscriptions = pgTable('paypal_subscriptions', {
  id: text('id').primaryKey(),
  intent_id: text('intent_id').notNull().references(() => paypalIntents.id),
  user_id: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  environment: text('environment').notNull(),
  merchant_id: text('merchant_id').notNull(),
  status: text('status').notNull(),
  plan_id: text('plan_id').notNull(),
  amount_ore: integer('amount_ore').notNull(),
  cancellation_requested_at: timestamp('cancellation_requested_at', { withTimezone: true, mode: 'date' }),
  cancel_request_id: text('cancel_request_id'),
  cancelled_at: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  reconciled_through_at: timestamp('reconciled_through_at', { withTimezone: true, mode: 'date' }),
  next_billing_at: timestamp('next_billing_at', { withTimezone: true, mode: 'date' }),
  // Per-subscription reconciliation backoff so one failing mapping cannot
  // abort the pass or starve other subscriptions.
  reconcile_failures: integer('reconcile_failures').notNull().default(0),
  reconcile_next_at: timestamp('reconcile_next_at', { withTimezone: true, mode: 'date' }),
  reconcile_error_code: text('reconcile_error_code'),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [index('paypal_subscription_user').on(t.user_id), index('paypal_subscription_status').on(t.status)]);

// Verified events enter here before acknowledgment; processing is replay-safe.
export const paypalWebhookInbox = pgTable('paypal_webhook_inbox', {
  id: text('id').primaryKey(),
  environment: text('environment').notNull(),
  merchant_id: text('merchant_id').notNull(),
  event_type: text('event_type').notNull(),
  resource_id: text('resource_id'),
  payload: jsonb('payload').notNull(),
  source: text('source').notNull().default('verified_webhook'),
  status: text('status').notNull().default('pending'),
  received_at: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  event_at: timestamp('event_at', { withTimezone: true, mode: 'date' }),
  processing_at: timestamp('processing_at', { withTimezone: true, mode: 'date' }),
  next_attempt_at: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
  attempt_count: integer('attempt_count').notNull().default(0),
  processed_at: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  error_code: text('error_code'),
  // Operator resolution of quarantined (needs_review) events: retried or
  // dismissed with a mandatory note. Dismissed events never post money.
  resolved_at: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  resolved_by: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  resolution: text('resolution'),
  resolution_note: text('resolution_note'),
}, (t) => [index('paypal_webhook_pending').on(t.status, t.received_at)]);

// Append-only economic postings: +gross, -fee, -refund, +fee credit. Posting
// amount is integer ore; provider economic reference enforces replay safety.
export const paypalPostings = pgTable('paypal_postings', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  environment: text('environment').notNull(),
  merchant_id: text('merchant_id').notNull(),
  provider_transaction_id: text('provider_transaction_id').notNull(),
  posting_kind: text('posting_kind').notNull(),
  source_id: text('source_id').notNull(),
  original_transaction_id: text('original_transaction_id'),
  intent_id: text('intent_id').references(() => paypalIntents.id),
  user_id: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  amount_ore: integer('amount_ore').notNull(),
  currency: text('currency').notNull(),
  effective_at: timestamp('effective_at', { withTimezone: true, mode: 'date' }).notNull(),
  posted_at: timestamp('posted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  verification: text('verification').notNull(),
}, (t) => [
  uniqueIndex('paypal_posting_unique_economic').on(t.environment, t.merchant_id, t.provider_transaction_id, t.posting_kind),
  index('paypal_posting_user_time').on(t.user_id, t.effective_at),
  index('paypal_posting_period').on(t.environment, t.effective_at),
]);

export const paypalReconciliation = pgTable('paypal_reconciliation', {
  environment: text('environment').primaryKey(),
  last_run_at: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  cursor_at: timestamp('cursor_at', { withTimezone: true, mode: 'date' }),
  status: text('status').notNull().default('idle'),
  error_code: text('error_code'),
  // cursor_at is the webhook-event recovery cursor; it advances as soon as
  // event recovery succeeds, independent of subscription/enrichment failures.
  last_success_at: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
  consecutive_failures: integer('consecutive_failures').notNull().default(0),
  failed_items: integer('failed_items').notNull().default(0),
});


// Provider transaction state is independent of append-only economic postings.
// A completed receipt with unknown fee/net is retained here but not allocated.
export const paypalTransactions = pgTable('paypal_transactions', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  environment: text('environment').notNull(),
  merchant_id: text('merchant_id').notNull(),
  provider_transaction_id: text('provider_transaction_id').notNull(),
  provider_kind: text('provider_kind').notNull(),
  original_transaction_id: text('original_transaction_id'),
  intent_id: text('intent_id').references(() => paypalIntents.id),
  user_id: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').notNull(),
  currency: text('currency').notNull(),
  gross_ore: integer('gross_ore'),
  fee_ore: integer('fee_ore'),
  net_ore: integer('net_ore'),
  effective_at: timestamp('effective_at', { withTimezone: true, mode: 'date' }),
  observed_at: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  // Last provider status seen for adjustment placeholders (e.g. PARTIALLY_REFUNDED).
  provider_status: text('provider_status'),
  // Enrichment retry state for net_unresolved rows.
  retry_count: integer('retry_count').notNull().default(0),
  next_retry_at: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),
  last_error_code: text('last_error_code'),
}, (t) => [
  uniqueIndex('paypal_transaction_identity').on(t.environment, t.merchant_id, t.provider_transaction_id),
  index('paypal_transaction_unresolved').on(t.status, t.observed_at),
  index('paypal_transaction_intent').on(t.intent_id),
]);

// Immutable month-by-month applications of verified live net receipts to lab
// cost. Recalculation appends a revision and propagates changed carry forward.
export const paypalMonthAllocations = pgTable('paypal_month_allocations', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  month: text('month').notNull(),
  revision: integer('revision').notNull(),
  previous_id: integer('previous_id'),
  source_fingerprint: text('source_fingerprint').notNull(),
  cost_statement_id: integer('cost_statement_id').references(() => electricityCostStatements.id, { onDelete: 'restrict' }),
  ledger_revision: integer('ledger_revision').notNull().default(0),
  status: text('status').notNull(),
  cost_ore: integer('cost_ore'),
  received_net_ore: integer('received_net_ore').notNull(),
  opening_balance_ore: integer('opening_balance_ore'),
  applied_ore: integer('applied_ore'),
  owner_remainder_ore: integer('owner_remainder_ore'),
  owner_adjustment_ore: integer('owner_adjustment_ore'),
  closing_balance_ore: integer('closing_balance_ore'),
  unresolved_count: integer('unresolved_count').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('paypal_month_allocation_revision').on(t.month, t.revision), index('paypal_month_allocation_month').on(t.month)]);

// Versioned configuration history. Secrets are never copied here; only
// whether the secret changed. Every save/enable/disable appends one row.
export const paypalConfigHistory = pgTable('paypal_config_history', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  environment: text('environment').notNull(),
  config_version: integer('config_version').notNull(),
  action: text('action').notNull(),
  actor_user_id: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  client_id: text('client_id'),
  merchant_id: text('merchant_id'),
  webhook_id: text('webhook_id'),
  monthly_plan_id: text('monthly_plan_id'),
  monthly_amount_ore: integer('monthly_amount_ore'),
  enabled: boolean('enabled').notNull(),
  secret_changed: boolean('secret_changed').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [index('paypal_config_history_env').on(t.environment, t.created_at)]);

// Provider resources created by an explicit admin setup action. The request
// ID is persisted before the provider call so a retry after a lost response
// reuses PayPal's idempotency instead of creating a duplicate. Scoped to the
// environment and REST app (client ID).
export const paypalSetupResources = pgTable('paypal_setup_resources', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  environment: text('environment').notNull(),
  client_id: text('client_id').notNull(),
  kind: text('kind').notNull(),
  resource_key: text('resource_key').notNull(),
  request_id: text('request_id').notNull(),
  provider_id: text('provider_id'),
  status: text('status').notNull().default('requested'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('paypal_setup_resource_key').on(t.environment, t.client_id, t.kind, t.resource_key)]);

// Optional manual fallback for bank transfers. A member report is evidence
// only and never posts. An administrator confirmation (with an evidence
// reference) posts one append-only live DKK receipt; the normalized bank
// reference is unique among non-rejected entries, and references matching an
// imported PayPal transaction are refused.
export const manualContributions = pgTable('manual_contributions', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  user_id: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  amount_ore: integer('amount_ore').notNull(),
  currency: text('currency').notNull().default('DKK'),
  reference: text('reference').notNull(),
  reference_key: text('reference_key').notNull(),
  received_at: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull(),
  status: text('status').notNull().default('reported'),
  member_note: text('member_note'),
  evidence: text('evidence'),
  reported_by: integer('reported_by').references(() => users.id, { onDelete: 'set null' }),
  reported_at: timestamp('reported_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  decided_by: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decided_at: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  reversed_at: timestamp('reversed_at', { withTimezone: true, mode: 'date' }),
}, (t) => [
  uniqueIndex('manual_contribution_reference').on(t.reference_key).where(sql`${t.status} <> 'rejected'`),
  index('manual_contribution_user').on(t.user_id, t.reported_at),
  index('manual_contribution_status').on(t.status, t.reported_at),
]);

// Non-posting provider states for payments this integration created: pending
// captures/sales, denials and disputes/holds. They are tracked separately so
// they are visible in the snapshot but never subtracted; only an actual
// refund/reversal posting changes net support (no double-counted loss).
export const paypalPaymentStates = pgTable('paypal_payment_states', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  environment: text('environment').notNull(),
  merchant_id: text('merchant_id').notNull(),
  kind: text('kind').notNull(),
  provider_ref: text('provider_ref').notNull(),
  related_transaction_id: text('related_transaction_id'),
  intent_id: text('intent_id').references(() => paypalIntents.id),
  status: text('status').notNull(),
  amount_ore: integer('amount_ore'),
  reason_code: text('reason_code'),
  opened_at: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  closed_at: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
}, (t) => [
  uniqueIndex('paypal_payment_state_ref').on(t.environment, t.merchant_id, t.kind, t.provider_ref),
  index('paypal_payment_state_open').on(t.environment, t.status),
]);

// Server-controlled monthly plans: one validated provider plan per offered
// amount. Members choose among these amounts only; a member's contribution is
// never changed by editing a shared plan.
export const paypalMonthlyPlans = pgTable('paypal_monthly_plans', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  environment: text('environment').notNull(),
  merchant_id: text('merchant_id').notNull(),
  plan_id: text('plan_id').notNull(),
  amount_ore: integer('amount_ore').notNull(),
  active: boolean('active').notNull().default(true),
  validated_at: timestamp('validated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('paypal_monthly_plan_id').on(t.environment, t.plan_id),
  uniqueIndex('paypal_monthly_plan_amount').on(t.environment, t.merchant_id, t.amount_ore).where(sql`${t.active}`),
]);
