// Part of the Drizzle PostgreSQL schema — see docs/postgres-conventions.md for conventions.
import { pgTable, integer, text, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { firewalls } from './infra.ts';

// Configurable FortiGate provisioning workflows (#16): an ordered, per-firewall+trigger
// list of whitelisted steps replacing the old hardcoded provisioning chains.
export const workflows = pgTable(
  'workflows',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    firewall_id: integer('firewall_id')
      .notNull()
      .references(() => firewalls.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').default(true),
    is_default: boolean('is_default').default(true),
    settings: jsonb('settings').default({}),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [uniqueIndex('workflows_firewall_id_trigger_unique').on(t.firewall_id, t.trigger)],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    workflow_id: integer('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    step_key: text('step_key').default(''),
    action: text('action').notNull(),
    label: text('label').default(''),
    params: jsonb('params').default({}),
    condition: text('condition').default(''),
    enabled: boolean('enabled').default(true),
    continue_on_error: boolean('continue_on_error').default(false),
  },
  (t) => [index('idx_workflow_steps_wf').on(t.workflow_id, t.position)],
);

// Runs record every created artifact so deprovision is artifact-based (reverse
// order), never re-derived. firewall_id is deliberately FK-less (denormalized).
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    workflow_id: integer('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    firewall_id: integer('firewall_id'),
    trigger: text('trigger').default(''),
    subject_type: text('subject_type').default(''),
    subject_id: text('subject_id').default(''),
    subject_label: text('subject_label').default(''),
    status: text('status').default('pending'),
    log: jsonb('log').default([]),
    artifacts: jsonb('artifacts').default([]),
    dry_run: boolean('dry_run').default(false),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    request_id: text('request_id').notNull().default(''),
  },
  (t) => [
    index('idx_workflow_runs_wf').on(t.workflow_id, t.created_at),
    index('idx_workflow_runs_subject').on(t.firewall_id, t.subject_type, t.subject_id),
    index('idx_workflow_runs_created').on(t.created_at),
  ],
);
