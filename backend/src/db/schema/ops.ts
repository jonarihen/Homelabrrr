// Part of the Drizzle PostgreSQL schema (transcribed from the pre-migration
// SQLite layer, now src/scripts/legacySqliteDb.ts) — see docs/postgres-conventions.md.
import {
  pgTable,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  jsonb,
  doublePrecision,
  index,
} from 'drizzle-orm/pg-core';

// Audit log. user_id is intentionally FK-less: audit rows must outlive the
// user they reference.
export const auditLog = pgTable(
  'audit_log',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id'),
    username: text('username').notNull(),
    action: text('action').notNull(),
    target: text('target').default(''),
    detail: text('detail').default(''),
    ip: text('ip').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    request_id: text('request_id').notNull().default(''),
    outcome: text('outcome').notNull().default('success'),
  },
  (t) => [
    index('idx_audit_log_created').on(t.created_at),
    index('idx_audit_log_user').on(t.user_id),
  ]
);

// App-database backup runs (dump + verify), one row per attempt.
export const backupRuns = pgTable('backup_runs', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  path: text('path').notNull().default(''),
  size_bytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  status: text('status').notNull(),
  detail: text('detail').notNull().default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  verified_at: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  request_id: text('request_id').notNull().default(''),
});

// Per-VM vzdump backup task monitors. user_id is intentionally FK-less;
// (node, vmid) is a soft reference. started_epoch is unix SECONDS off the
// PVE node's clock (parsed from the UPID).
export const backupTasks = pgTable(
  'backup_tasks',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id'),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
    upid: text('upid').notNull(),
    storage: text('storage').default(''),
    status: text('status').default('running'),
    status_detail: text('status_detail').default(''),
    progress: doublePrecision('progress'),
    progress_detail: text('progress_detail').default(''),
    log_offset: integer('log_offset').default(0),
    started_epoch: bigint('started_epoch', { mode: 'number' }).default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    finished_at: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    request_id: text('request_id').notNull().default(''),
  },
  (t) => [
    index('idx_backup_tasks_vm').on(t.node, t.vmid),
    index('idx_backup_tasks_created').on(t.created_at),
  ]
);

// Discord / webhook notification channels. url is a bearer secret, encrypted
// at rest by app code (utils/notify) — stored as plain text here.
export const notificationWebhooks = pgTable('notification_webhooks', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  event_types: jsonb('event_types').default([]),
  enabled: boolean('enabled').default(true),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
});
