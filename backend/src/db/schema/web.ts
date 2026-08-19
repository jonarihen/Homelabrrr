// Part of the Drizzle schema (web publishing domain: Caddy servers + sites) — see docs/postgres-conventions.md.
import { pgTable, integer, text, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './auth.ts';
import { firewalls } from './infra.ts';

export const caddyServers = pgTable('caddy_servers', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  api_url: text('api_url').notNull(),
  auth_type: text('auth_type').default('none'),
  auth_secret: text('auth_secret').default(''),
  server_name: text('server_name').default(''),
  verify_tls: boolean('verify_tls').default(true),
  wan_ip: text('wan_ip').default(''),
  fortigate_id: integer('fortigate_id').references(() => firewalls.id, { onDelete: 'set null' }),
  inspection_profile: text('inspection_profile').default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  ssh_host: text('ssh_host').default(''),
  ssh_port: integer('ssh_port').default(22),
  ssh_user: text('ssh_user').default(''),
  ssh_auth_type: text('ssh_auth_type').default('key'),
  ssh_secret: text('ssh_secret').default(''),
  ssh_host_key: text('ssh_host_key').default(''),
  snippet_path: text('snippet_path').default('/etc/caddy/homelabrrr.caddy'),
  caddyfile_path: text('caddyfile_path').default('/etc/caddy/Caddyfile'),
  inspection_bundle_cert: text('inspection_bundle_cert').default(''),
});

export const caddySites = pgTable(
  'caddy_sites',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    server_id: integer('server_id')
      .notNull()
      .references(() => caddyServers.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull().unique(),
    upstream_host: text('upstream_host').notNull(),
    upstream_port: integer('upstream_port').notNull().default(80),
    owner_user_id: integer('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').default('pending'),
    status_detail: text('status_detail').default(''),
    steps: jsonb('steps'),
    fortigate_id: integer('fortigate_id').references(() => firewalls.id, { onDelete: 'set null' }),
    inspection_profile: text('inspection_profile').default(''),
    cert_name: text('cert_name').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    managed: boolean('managed').default(true),
    kind: text('kind').default('reverse_proxy'),
    wildcard: text('wildcard').default(''),
    probe_status: text('probe_status').default(''),
    probe_http_status: integer('probe_http_status').default(0),
    probe_detail: text('probe_detail').default(''),
    probe_at: timestamp('probe_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('idx_caddy_sites_server').on(t.server_id),
    index('idx_caddy_sites_owner').on(t.owner_user_id),
    index('idx_caddy_sites_fortigate').on(t.fortigate_id),
  ]
);
