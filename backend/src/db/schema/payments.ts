import { pgTable, integer, text, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './auth.ts';

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
  cancelled_at: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  reconciled_through_at: timestamp('reconciled_through_at', { withTimezone: true, mode: 'date' }),
  next_billing_at: timestamp('next_billing_at', { withTimezone: true, mode: 'date' }),
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
  status: text('status').notNull().default('pending'),
  received_at: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  event_at: timestamp('event_at', { withTimezone: true, mode: 'date' }),
  processing_at: timestamp('processing_at', { withTimezone: true, mode: 'date' }),
  processed_at: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  error_code: text('error_code'),
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
}, (t) => [
  uniqueIndex('paypal_transaction_identity').on(t.environment, t.merchant_id, t.provider_transaction_id),
  index('paypal_transaction_unresolved').on(t.status, t.observed_at),
  index('paypal_transaction_intent').on(t.intent_id),
]);
