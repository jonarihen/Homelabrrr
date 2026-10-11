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

// Pricing is independent of delayed meter consumption. Contract and charge
// revisions are effective-dated; changing one never rewrites a finalized bill.
export const electricityContracts = pgTable('electricity_contracts', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  label: text('label').notNull(),
  kind: text('kind').notNull(), // spot or fixed_all_in
  area: text('area').notNull(), // DK1 or DK2
  valid_from: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull(),
  valid_to: timestamp('valid_to', { withTimezone: true, mode: 'date' }),
  fixed_dkk_per_kwh: numeric('fixed_dkk_per_kwh', { precision: 12, scale: 6 }),
  spot_margin_dkk_per_kwh: numeric('spot_margin_dkk_per_kwh', { precision: 12, scale: 6 }),
  vat_rate: numeric('vat_rate', { precision: 8, scale: 6 }),
  required_components: jsonb('required_components'),
  fixed_monthly_ore: integer('fixed_monthly_ore'),
  fixed_fee_allocation: text('fixed_fee_allocation').notNull().default('none'),
  fixed_fee_manual_share: numeric('fixed_fee_manual_share', { precision: 8, scale: 6 }),
  revision: integer('revision').notNull().default(1),
  active: boolean('active').notNull().default(false),
  provenance: text('provenance').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [index('electricity_contract_validity').on(t.active, t.valid_from, t.valid_to)]);

export const electricityTariffs = pgTable('electricity_tariffs', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  contract_id: integer('contract_id').notNull().references(() => electricityContracts.id, { onDelete: 'restrict' }),
  component: text('component').notNull(), // network, system, tax, retailer
  valid_from: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull(),
  valid_to: timestamp('valid_to', { withTimezone: true, mode: 'date' }).notNull(),
  dkk_per_kwh: numeric('dkk_per_kwh', { precision: 12, scale: 6 }).notNull(),
  vat_included: boolean('vat_included').notNull().default(false),
  provenance: text('provenance').notNull(),
  revision: integer('revision').notNull().default(1),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [index('electricity_tariff_validity').on(t.contract_id, t.component, t.valid_from, t.valid_to)]);

export const electricitySpotPrices = pgTable('electricity_spot_prices', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  area: text('area').notNull(),
  start_utc: timestamp('start_utc', { withTimezone: true, mode: 'date' }).notNull(),
  end_utc: timestamp('end_utc', { withTimezone: true, mode: 'date' }).notNull(),
  dkk_per_kwh: numeric('dkk_per_kwh', { precision: 12, scale: 6 }).notNull(),
  source_revision: text('source_revision').notNull(),
  fetched_at: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (t) => [
  uniqueIndex('electricity_spot_identity').on(t.area, t.start_utc),
  index('electricity_spot_range').on(t.area, t.start_utc, t.end_utc),
]);

export const electricityBills = pgTable('electricity_bills', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  contract_id: integer('contract_id').notNull().references(() => electricityContracts.id, { onDelete: 'restrict' }),
  period_start: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
  period_end: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
  amount_ore: integer('amount_ore').notNull(),
  billed_kwh: numeric('billed_kwh', { precision: 20, scale: 6 }),
  status: text('status').notNull().default('due'),
  paid_at: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
  paid_ore: integer('paid_ore'),
  reference: text('reference'),
  note: text('note'),
  kind: text('kind').notNull().default('settlement'),
  finalized: boolean('finalized').notNull().default(false),
  revision: integer('revision').notNull().default(1),
}, (t) => [index('electricity_bill_period').on(t.contract_id, t.period_start, t.period_end)]);

// Immutable calculation revisions. A finalized statement is never edited in
// place; explicit recalculation appends a new revision with the prior ID.
export const electricityCostStatements = pgTable('electricity_cost_statements', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  contract_id: integer('contract_id').notNull().references(() => electricityContracts.id, { onDelete: 'restrict' }),
  period_start: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
  period_end: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
  revision: integer('revision').notNull(),
  previous_id: integer('previous_id'),
  calculation: jsonb('calculation').notNull(),
  finalized: boolean('finalized').notNull().default(true),
  reason: text('reason').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('electricity_statement_revision').on(t.contract_id, t.period_start, t.period_end, t.revision),
  index('electricity_statement_period').on(t.contract_id, t.period_start),
]);
