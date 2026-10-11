import { pgTable, integer, text, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { hardwareConnections } from './infra.ts';
import { users } from './auth.ts';
import type { WeeklyPowerSchedule, PowerPricePolicy, PriceLatch } from '../../services/powerPolicy.ts';

export const hardwarePowerPolicies = pgTable('hardware_power_policies', {
  hardware_id: integer('hardware_id').primaryKey().references(() => hardwareConnections.id, { onDelete: 'restrict' }),
  automation_enabled: boolean('automation_enabled').notNull().default(false),
  paused: boolean('paused').notNull().default(false),
  drift_hold: boolean('drift_hold').notNull().default(false),
  schedule: jsonb('schedule').$type<WeeklyPowerSchedule>().notNull(),
  price_policy: jsonb('price_policy').$type<PowerPricePolicy>().notNull(),
  manual_mode: text('manual_mode'),
  manual_expires_at: timestamp('manual_expires_at', { withTimezone: true, mode: 'date' }),
  latch: jsonb('latch').$type<PriceLatch>(),
  claim_token: text('claim_token'),
  claim_expires_at: timestamp('claim_expires_at', { withTimezone: true, mode: 'date' }),
  last_verified_mode: text('last_verified_mode'),
  last_outcome: text('last_outcome'),
  last_outcome_at: timestamp('last_outcome_at', { withTimezone: true, mode: 'date' }),
  // Sanitized error category or policy-validation message; never upstream text.
  last_error: text('last_error'),
  // Consecutive failed/unknown/unreadable attempts drive backoff and one
  // deduplicated persistent-failure notification.
  failure_count: integer('failure_count').notNull().default(0),
  next_attempt_at: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
  failure_notified_at: timestamp('failure_notified_at', { withTimezone: true, mode: 'date' }),
  // A dispatched write whose result is unresolved. The next tick verifies it
  // read-only before any retry; it is never treated as external drift.
  pending_target: text('pending_target'),
  pending_operation_id: integer('pending_operation_id'),
  // NULL while drift_hold is set means "until explicit Resume" (price-only or OS Control).
  drift_hold_until: timestamp('drift_hold_until', { withTimezone: true, mode: 'date' }),
  version: integer('version').notNull().default(1),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('hardware_power_policies_claim_idx').on(table.claim_expires_at)]);

export const hardwarePowerOperations = pgTable('hardware_power_operations', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  hardware_id: integer('hardware_id').notNull().references(() => hardwareConnections.id, { onDelete: 'restrict' }),
  actor: text('actor').notNull(),
  prior_mode: text('prior_mode'),
  target_mode: text('target_mode'),
  reason: text('reason').notNull(),
  outcome: text('outcome').notNull(),
  policy_version: integer('policy_version').notNull(),
  price_revision: text('price_revision'),
  actor_user_id: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  config_version: integer('config_version'),
  schedule_version: integer('schedule_version'),
  price_policy_version: integer('price_policy_version'),
  price_dkk_per_kwh: text('price_dkk_per_kwh'),
  price_start_utc: timestamp('price_start_utc', { withTimezone: true, mode: 'date' }),
  price_end_utc: timestamp('price_end_utc', { withTimezone: true, mode: 'date' }),
  // Basis/area/contract reference and revisions only; never credentials.
  price_source: jsonb('price_source').$type<Record<string, string>>(),
  thresholds: jsonb('thresholds').$type<Record<string, unknown>>(),
  error_category: text('error_category'),
  // Links the pre-dispatch "requested" row to the lease that produced it.
  claim_token: text('claim_token'),
  completed_at: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  occurred_at: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  index('hardware_power_operations_history_idx').on(table.hardware_id, table.occurred_at),
  index('hardware_power_operations_claim_idx').on(table.claim_token),
]);
