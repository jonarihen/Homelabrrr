// Part of the Drizzle ORM PostgreSQL schema — conventions in docs/postgres-conventions.md.

import { pgTable, integer, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './auth.ts';

// Migration bookkeeping. `version` is supplied by the migration runner, so it
// is a plain integer primary key — NOT an identity column.
export const schemaMigrations = pgTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  applied_at: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const pveHosts = pgTable('pve_hosts', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').default(8006),
  token_id: text('token_id').notNull(),
  // Encrypted at rest by the app (enc:v1: prefix) — stored as plain text here.
  token_secret: text('token_secret').notNull(),
  // CREATE says DEFAULT 1, a later ALTER says DEFAULT 0; we keep the secure
  // default (a data migration in db.ts forces existing rows to 1).
  verify_tls: boolean('verify_tls').default(true),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  ssh_host: text('ssh_host').default(''),
  ssh_port: integer('ssh_port').default(22),
  ssh_user: text('ssh_user').default('root'),
  ssh_auth_type: text('ssh_auth_type').default('key'),
  // Encrypted at rest by the app.
  ssh_secret: text('ssh_secret').default(''),
  ssh_host_key: text('ssh_host_key').default(''),
});

export const firewalls = pgTable('firewalls', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  type: text('type').notNull().default('fortigate'),
  host: text('host').notNull(),
  port: integer('port').default(443),
  // Encrypted at rest by the app.
  api_key: text('api_key').notNull(),
  vdom: text('vdom').default('root'),
  parent_interface: text('parent_interface').default('fortilink'),
  wan_interface: text('wan_interface').default('wan1'),
  vlan_range_start: integer('vlan_range_start').default(1001),
  vlan_range_end: integer('vlan_range_end').default(1999),
  verify_tls: boolean('verify_tls').default(true),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  lab_vdom_link: text('lab_vdom_link').default('lab-root0'),
  root_vdom: text('root_vdom').default('root'),
  root_vdom_link: text('root_vdom_link').default('lab-root1'),
  route_gateway: text('route_gateway').default('10.255.254.2'),
  trunk_switch_serial: text('trunk_switch_serial').default(''),
  trunk_switch_port: text('trunk_switch_port').default(''),
  external_ip: text('external_ip').default(''),
  root_wan_zone: text('root_wan_zone').default('underlay'),
});

export const vlans = pgTable('vlans', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  tag: integer('tag').notNull().unique(),
  mode: text('mode').default('managed'),
  subnet_cidr: text('subnet_cidr').default(''),
  description: text('description').default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
});

export const userVlans = pgTable('user_vlans', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  user_id: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vlan_id: integer('vlan_id').notNull().references(() => vlans.id, { onDelete: 'cascade' }),
}, (t) => [
  uniqueIndex('user_vlans_user_id_vlan_id_unique').on(t.user_id, t.vlan_id),
  index('idx_user_vlans_vlan').on(t.vlan_id),
]);

// Storage pool exposure: a pool with NO row here is treated as exposed
// (default-open). Keyed by (pve_host_id, storage).
export const storageVisibility = pgTable('storage_visibility', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  pve_host_id: integer('pve_host_id').notNull().references(() => pveHosts.id, { onDelete: 'cascade' }),
  storage: text('storage').notNull(),
  exposed: boolean('exposed').default(true),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
}, (t) => [
  uniqueIndex('storage_visibility_pve_host_id_storage_unique').on(t.pve_host_id, t.storage),
]);

// Landing page: admin-managed notices (maintenance windows etc.).
// source marks notices auto-published by a subsystem ('' = admin-authored).
export const portalNotices = pgTable('portal_notices', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  title: text('title').notNull(),
  body: text('body').default(''),
  level: text('level').default('info'),
  active: boolean('active').default(true),
  created_by: text('created_by').default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  source: text('source').default(''),
});

export const portalLinks = pgTable('portal_links', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  label: text('label').notNull(),
  url: text('url').notNull(),
  description: text('description').default(''),
  sort_order: integer('sort_order').default(0),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
});

// Node maintenance mode (soft drain). node_name holds a nodeRef string
// ('<hostId>~<node>'); notice_id links the auto-published portal_notices row.
export const nodeMaintenance = pgTable('node_maintenance', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  pve_host_id: integer('pve_host_id'),
  node_name: text('node_name').notNull(),
  reason: text('reason').default(''),
  until: timestamp('until', { withTimezone: true, mode: 'date' }),
  notice_id: integer('notice_id').references(() => portalNotices.id, { onDelete: 'set null' }),
  created_by: text('created_by').default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
}, (t) => [
  index('idx_node_maintenance_notice').on(t.notice_id),
]);
