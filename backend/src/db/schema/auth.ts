// Part of the Drizzle PostgreSQL schema (auth domain) — conventions in docs/postgres-conventions.md.

import {
  pgTable,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { bytea } from '../columnTypes.ts';

// ─── Roles (RBAC) ────────────────────────────────────────────────────────────

export const roles = pgTable('roles', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull().unique(),
  description: text('description').default(''),
  built_in: boolean('built_in').default(false),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  max_cores: integer('max_cores'),
  max_memory_gb: integer('max_memory_gb'),
  max_storage_gb: integer('max_storage_gb'),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    role_id: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.role_id, t.permission] })]
);

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    username: text('username').notNull().unique(),
    password: text('password').notNull(),
    is_admin: boolean('is_admin').default(false),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    see_all_vms: boolean('see_all_vms').default(false),
    can_operate_all_vms: boolean('can_operate_all_vms').default(false),
    totp_secret: text('totp_secret'),
    totp_enabled: boolean('totp_enabled').default(false),
    require_2fa: boolean('require_2fa').default(false),
    can_provision: boolean('can_provision').default(false),
    can_manage_hosts: boolean('can_manage_hosts').default(false),
    can_manage_firewalls: boolean('can_manage_firewalls').default(false),
    can_manage_port_forwards: boolean('can_manage_port_forwards').default(false),
    can_manage_vlans: boolean('can_manage_vlans').default(false),
    can_manage_policies: boolean('can_manage_policies').default(false),
    can_manage_templates: boolean('can_manage_templates').default(false),
    can_manage_users: boolean('can_manage_users').default(false),
    can_manage_assignments: boolean('can_manage_assignments').default(false),
    can_view_audit_log: boolean('can_view_audit_log').default(false),
    can_create_vms: boolean('can_create_vms').default(false),
    can_edit_vm_hardware: boolean('can_edit_vm_hardware').default(false),
    can_manage_websites: boolean('can_manage_websites').default(false),
    can_manage_public_ips: boolean('can_manage_public_ips').default(false),
    notify_opt_out: boolean('notify_opt_out').default(false),
    role_id: integer('role_id').references(() => roles.id, { onDelete: 'set null' }),
    max_cores: integer('max_cores'),
    max_memory_gb: integer('max_memory_gb'),
    max_storage_gb: integer('max_storage_gb'),
  },
  (t) => [index('idx_users_role').on(t.role_id)]
);

// ─── Sessions (express-session store; not in db.ts — created at runtime) ─────

export const sessions = pgTable(
  'sessions',
  {
    sid: text('sid').primaryKey(),
    sess: jsonb('sess').notNull(),
    expire: timestamp('expire', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [index('idx_sessions_expire').on(t.expire)]
);

// ─── Invites ─────────────────────────────────────────────────────────────────

export const invites = pgTable(
  'invites',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    token_hash: text('token_hash').notNull().unique(),
    created_by: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_by_username: text('created_by_username').default(''),
    preset: jsonb('preset').notNull().default({}),
    require_2fa: boolean('require_2fa').default(false),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    used_at: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    used_by: integer('used_by').references(() => users.id, { onDelete: 'set null' }),
    used_by_username: text('used_by_username').default(''),
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [
    index('idx_invites_created_by').on(t.created_by),
    index('idx_invites_used_by').on(t.used_by),
  ]
);

// ─── API tokens ──────────────────────────────────────────────────────────────

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    token_hash: text('token_hash').notNull().unique(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    scopes: text('scopes').notNull().default('read'),
  },
  (t) => [
    index('idx_api_tokens_hash').on(t.token_hash),
    index('idx_api_tokens_user').on(t.user_id),
  ]
);

// ─── Recovery codes ──────────────────────────────────────────────────────────

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    code_hash: text('code_hash').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    used_at: timestamp('used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('recovery_codes_user_id_code_hash_unique').on(t.user_id, t.code_hash),
    index('idx_recovery_codes_user').on(t.user_id, t.used_at),
  ]
);

// ─── WebAuthn credentials ────────────────────────────────────────────────────

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: text('id').primaryKey(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    public_key: bytea('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: jsonb('transports').notNull().default([]),
    device_type: text('device_type').notNull().default(''),
    backed_up: boolean('backed_up').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('webauthn_credentials_user_id_name_unique').on(t.user_id, t.name),
    index('idx_webauthn_credentials_user').on(t.user_id),
  ]
);

// ─── Rate-limit attempt logs (epoch-ms timestamps) ───────────────────────────

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    username: text('username').notNull(),
    ip: text('ip').notNull().default(''),
    attempted_at: bigint('attempted_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_login_attempts').on(t.username, t.attempted_at),
    index('idx_login_attempts_ip').on(t.username, t.ip, t.attempted_at),
  ]
);

export const twoFactorAttempts = pgTable(
  'two_factor_attempts',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    username: text('username').notNull(),
    attempted_at: bigint('attempted_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('idx_two_factor_attempts').on(t.username, t.attempted_at)]
);

export const tokenAuthAttempts = pgTable(
  'token_auth_attempts',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    ip: text('ip').notNull(),
    attempted_at: bigint('attempted_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('idx_token_auth_attempts').on(t.ip, t.attempted_at)]
);

export const sshConnectionAttempts = pgTable(
  'ssh_connection_attempts',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    attempted_at: bigint('attempted_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('idx_ssh_connection_attempts_user').on(t.user_id, t.kind, t.attempted_at)]
);
