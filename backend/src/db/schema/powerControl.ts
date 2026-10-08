import { pgTable, integer, text, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { hardwareConnections } from './infra.ts';
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
  occurred_at: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('hardware_power_operations_history_idx').on(table.hardware_id, table.occurred_at)]);
