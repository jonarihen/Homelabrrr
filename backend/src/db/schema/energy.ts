import { pgTable, integer, text, boolean, timestamp, numeric, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

// A single owner connection. The refresh token is always encrypted by the service.
export const eloverblikConnections = pgTable('eloverblik_connections', {
  id: integer('id').primaryKey(),
  refresh_token: text('refresh_token'),
  config_version: integer('config_version').notNull().default(1),
  enabled: boolean('enabled').notNull().default(false),
  selected_meter_id: text('selected_meter_id'),
  meter_scope: text('meter_scope').notNull().default('household'),
  import_cursor: timestamp('import_cursor', { withTimezone: true, mode: 'date' }),
  last_attempt_at: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
  last_success_at: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
  latest_interval_end: timestamp('latest_interval_end', { withTimezone: true, mode: 'date' }),
  last_error_code: text('last_error_code'),
});

// Each provider series and interval is unique; only A04/A64 consumption in kWh
// can be used for meter totals, never summed with other aggregation levels.
export const eloverblikIntervals = pgTable('eloverblik_intervals', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  meter_id: text('meter_id').notNull(),
  series_key: text('series_key').notNull(),
  business_type: text('business_type').notNull(),
  aggregation: text('aggregation').notNull(),
  resolution: text('resolution').notNull(),
  interval_start: timestamp('interval_start', { withTimezone: true, mode: 'date' }).notNull(),
  interval_end: timestamp('interval_end', { withTimezone: true, mode: 'date' }).notNull(),
  energy_kwh: numeric('energy_kwh', { precision: 20, scale: 6 }),
  quality: text('quality'),
  fetched_at: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('eloverblik_interval_identity').on(t.meter_id, t.series_key, t.aggregation, t.interval_start, t.interval_end),
  index('eloverblik_interval_range').on(t.meter_id, t.interval_start),
]);

// A source-observation version, not a claimed historical tariff effective date.
export const eloverblikChargeSnapshots = pgTable('eloverblik_charge_snapshots', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  meter_id: text('meter_id').notNull(),
  content_hash: text('content_hash').notNull(),
  source_payload: jsonb('source_payload').notNull(),
  observed_at: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('eloverblik_charge_version').on(t.meter_id, t.content_hash),
  index('eloverblik_charge_recent').on(t.meter_id, t.observed_at),
]);
