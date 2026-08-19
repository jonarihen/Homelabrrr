// Part of the Drizzle PostgreSQL schema (VM domain) — see docs/postgres-conventions.md for the transcription rules.
import {
  pgTable,
  integer,
  smallint,
  bigint,
  text,
  boolean,
  timestamp,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth.ts';

export const vmAssignments = pgTable(
  'vm_assignments',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
  },
  (t) => [
    uniqueIndex('vm_assignments_node_vmid_unique').on(t.node, t.vmid),
    index('idx_vm_assignments_user').on(t.user_id),
  ]
);

export const sshKeys = pgTable(
  'ssh_keys',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Encrypted at rest by app code (enc:v1: prefix) — stays plain text here.
    private_key: text('private_key').notNull(),
    public_key: text('public_key').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [index('idx_ssh_keys_user').on(t.user_id)]
);

export const vmSshConfigs = pgTable(
  'vm_ssh_configs',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
    host: text('host').notNull(),
    port: integer('port').default(22),
    host_fingerprint: text('host_fingerprint').default(''),
    username: text('username').default('root'),
  },
  (t) => [uniqueIndex('vm_ssh_configs_node_vmid_unique').on(t.node, t.vmid)]
);

export const vmSshUserConfigs = pgTable(
  'vm_ssh_user_configs',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
    username: text('username').default('root'),
  },
  (t) => [uniqueIndex('vm_ssh_user_configs_user_node_vmid_unique').on(t.user_id, t.node, t.vmid)]
);

export const vmLeases = pgTable(
  'vm_leases',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
    lease_days: integer('lease_days').default(0),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    renewal_count: integer('renewal_count').default(0),
    last_renewed_at: timestamp('last_renewed_at', { withTimezone: true, mode: 'date' }),
    exempt: boolean('exempt').default(false),
    expired: boolean('expired').default(false),
    expired_at: timestamp('expired_at', { withTimezone: true, mode: 'date' }),
    auto_stopped: boolean('auto_stopped').default(false),
    created_by: text('created_by').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [uniqueIndex('vm_leases_node_vmid_unique').on(t.node, t.vmid)]
);

export const vmSchedules = pgTable(
  'vm_schedules',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
    enabled: boolean('enabled').default(true),
    stop_time: text('stop_time').default(''),
    start_time: text('start_time').default(''),
    // 7-bit day mask (bit 0 = Sunday … bit 6 = Saturday).
    days: smallint('days').default(127),
    timezone: text('timezone').default('UTC'),
    // Epoch-ms "skip tonight" one-off.
    skip_until: bigint('skip_until', { mode: 'number' }).default(0),
    running_due_to_manual: boolean('running_due_to_manual').default(false),
    stopped_this_window: boolean('stopped_this_window').default(false),
    // Previous tick's off-window state; -1 = unknown (edge detection across restarts).
    last_off: smallint('last_off').default(-1),
    last_action: text('last_action').default(''),
    last_action_at: bigint('last_action_at', { mode: 'number' }).default(0),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [uniqueIndex('vm_schedules_node_vmid_unique').on(t.node, t.vmid)]
);

export const vmTemplates = pgTable(
  'vm_templates',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    name: text('name').notNull(),
    description: text('description').default(''),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
    default_cores: integer('default_cores').default(2),
    default_memory: integer('default_memory').default(2048),
    default_disk_gb: integer('default_disk_gb').default(20),
    default_storage: text('default_storage').default('local-lvm'),
    cloud_init: boolean('cloud_init').default(false),
    enabled: boolean('enabled').default(true),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [uniqueIndex('vm_templates_node_vmid_unique').on(t.node, t.vmid)]
);

export const cloudImages = pgTable('cloud_images', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  node: text('node').notNull(),
  storage: text('storage').notNull(),
  volid: text('volid').default(''),
  size: integer('size').default(0),
  status: text('status').default('downloading'),
  status_detail: text('status_detail').default(''),
  upid: text('upid').default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  default_storage: text('default_storage').default(''),
  // JSON object keyed by pve_hosts.id → storage id; SQLite default '' is not valid JSON, so nullable with no default.
  default_storage_map: jsonb('default_storage_map'),
  console_patch_status: text('console_patch_status').default(''),
  console_patch_detail: text('console_patch_detail').default(''),
  request_id: text('request_id').notNull().default(''),
});

export const isos = pgTable('isos', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  node: text('node').notNull(),
  storage: text('storage').notNull(),
  volid: text('volid').default(''),
  size: integer('size').default(0),
  status: text('status').default('downloading'),
  status_detail: text('status_detail').default(''),
  upid: text('upid').default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  request_id: text('request_id').notNull().default(''),
});

export const provisionedVms = pgTable(
  'provisioned_vms',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    node: text('node').notNull(),
    vmid: integer('vmid').notNull(),
    name: text('name').notNull(),
    template_id: integer('template_id').references(() => vmTemplates.id, { onDelete: 'set null' }),
    source_type: text('source_type').default('template'),
    cloud_image_id: integer('cloud_image_id').references(() => cloudImages.id, {
      onDelete: 'set null',
    }),
    steps: jsonb('steps'),
    status: text('status').default('creating'),
    status_detail: text('status_detail').default(''),
    upid: text('upid').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    request_id: text('request_id').notNull().default(''),
    upstream_status: text('upstream_status').notNull().default(''),
    upstream_checked_at: timestamp('upstream_checked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('idx_provisioned_vms_user').on(t.user_id),
    index('idx_provisioned_vms_status').on(t.status),
    index('idx_provisioned_vms_cloud_image').on(t.cloud_image_id),
    index('idx_provisioned_vms_template').on(t.template_id),
  ]
);

export const vmMigrations = pgTable(
  'vm_migrations',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    // Deliberately FK-less (audit-style reference; user rows may outlive/miss it).
    user_id: integer('user_id'),
    vmid: integer('vmid').notNull(),
    name: text('name').default(''),
    vmtype: text('vmtype').default('qemu'),
    source_node: text('source_node').notNull(),
    target_node: text('target_node').notNull(),
    target_storage: text('target_storage').default(''),
    target_bridge: text('target_bridge').default(''),
    online: boolean('online').default(false),
    delete_source: boolean('delete_source').default(true),
    status: text('status').default('running'),
    status_detail: text('status_detail').default(''),
    upid: text('upid').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    finished_at: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    mode: text('mode').default('remote_migrate'),
    steps: jsonb('steps'),
    kept_source: boolean('kept_source').default(false),
    progress: doublePrecision('progress'),
    progress_detail: text('progress_detail').default(''),
    log_offset: integer('log_offset').default(0),
    request_id: text('request_id').notNull().default(''),
    upstream_status: text('upstream_status').notNull().default(''),
    upstream_checked_at: timestamp('upstream_checked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('idx_vm_migrations_status').on(t.status)]
);
