// Part of the Drizzle schema (network domain) — see docs/postgres-conventions.md for conventions.
import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { firewalls, vlans } from './infra.ts';
import { users } from './auth.ts';
import { workflowRuns } from './workflows.ts';

export const publicIpPools = pgTable(
  'public_ip_pools',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    firewall_id: integer('firewall_id')
      .notNull()
      .references(() => firewalls.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    vdom: text('vdom').default('root'),
    external_interface: text('external_interface').notNull(),
    gre_gateway: text('gre_gateway').default(''),
    lab_ingress_interface: text('lab_ingress_interface').default(''),
    cidr: text('cidr').default(''),
    mtu: integer('mtu'),
    tcp_mss: integer('tcp_mss'),
    kill_switch_enabled: boolean('kill_switch_enabled').default(true),
    enabled: boolean('enabled').default(true),
    notes: text('notes').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [
    uniqueIndex('public_ip_pools_firewall_id_name_unique').on(t.firewall_id, t.name),
    index('idx_public_ip_pools_fw').on(t.firewall_id),
  ],
);

// firewall_id is deliberately denormalized from the pool (see db.ts) so that
// UNIQUE(firewall_id, address) can be enforced; it gets no FK.
export const publicIps = pgTable(
  'public_ips',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    pool_id: integer('pool_id')
      .notNull()
      .references(() => publicIpPools.id, { onDelete: 'cascade' }),
    firewall_id: integer('firewall_id').notNull(),
    address: text('address').notNull(),
    state: text('state').notNull().default('available'),
    reserved_reason: text('reserved_reason').default(''),
    notes: text('notes').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [
    uniqueIndex('public_ips_pool_id_address_unique').on(t.pool_id, t.address),
    uniqueIndex('public_ips_firewall_id_address_unique').on(t.firewall_id, t.address),
    index('idx_public_ips_pool').on(t.pool_id),
    index('idx_public_ips_state').on(t.pool_id, t.state),
  ],
);

// firewall_id / proxmox_host_id / provision_run_id are soft references: no FKs.
export const publicIpAssignments = pgTable(
  'public_ip_assignments',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    public_ip_id: integer('public_ip_id')
      .notNull()
      .references(() => publicIps.id, { onDelete: 'cascade' }),
    firewall_id: integer('firewall_id').notNull(),
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    proxmox_host_id: integer('proxmox_host_id'),
    node: text('node').default(''),
    vmid: integer('vmid'),
    private_ip: text('private_ip').notNull(),
    status: text('status').notNull().default('pending'),
    status_detail: text('status_detail').default(''),
    egress_enabled: boolean('egress_enabled').default(true),
    provision_run_id: integer('provision_run_id'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_public_ip_assignments_ip').on(t.public_ip_id),
    uniqueIndex('idx_public_ip_assignments_egress')
      .on(t.firewall_id, t.private_ip)
      .where(sql`egress_enabled`),
    index('idx_public_ip_assignments_user').on(t.user_id),
  ],
);

// public_ip_id is a soft reference (NULL = the firewall's default WAN address): no FK.
export const managedVips = pgTable(
  'managed_vips',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    firewall_id: integer('firewall_id')
      .notNull()
      .references(() => firewalls.id, { onDelete: 'cascade' }),
    vip_name: text('vip_name').notNull(),
    policy_id: integer('policy_id'),
    service_name: text('service_name').default(''),
    protocol: text('protocol').default('tcp'),
    ext_port: integer('ext_port').notNull(),
    mapped_ip: text('mapped_ip').notNull(),
    mapped_port: integer('mapped_port').notNull(),
    dst_interface: text('dst_interface').default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    lab_policy_id: integer('lab_policy_id'),
    vlan_interface: text('vlan_interface').default(''),
    artifacts: jsonb('artifacts'),
    workflow_run_id: integer('workflow_run_id').references(() => workflowRuns.id, {
      onDelete: 'set null',
    }),
    public_ip_id: integer('public_ip_id'),
  },
  (t) => [
    uniqueIndex('managed_vips_firewall_id_vip_name_unique').on(t.firewall_id, t.vip_name),
    index('idx_managed_vips_public_ip').on(t.public_ip_id),
    index('idx_managed_vips_endpoint').on(t.firewall_id, t.public_ip_id, t.protocol, t.ext_port),
    index('idx_managed_vips_workflow_run').on(t.workflow_run_id),
  ],
);

export const firewallVlanSync = pgTable(
  'firewall_vlan_sync',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    firewall_id: integer('firewall_id')
      .notNull()
      .references(() => firewalls.id, { onDelete: 'cascade' }),
    vlan_id: integer('vlan_id')
      .notNull()
      .references(() => vlans.id, { onDelete: 'cascade' }),
    interface_name: text('interface_name').notNull(),
    policy_ids: jsonb('policy_ids').default([]),
    dhcp_server_id: integer('dhcp_server_id'),
    synced_at: timestamp('synced_at', { withTimezone: true, mode: 'date' }).defaultNow(),
    artifacts: jsonb('artifacts'),
    workflow_run_id: integer('workflow_run_id').references(() => workflowRuns.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('firewall_vlan_sync_firewall_id_vlan_id_unique').on(t.firewall_id, t.vlan_id),
    index('idx_firewall_vlan_sync_run').on(t.workflow_run_id),
  ],
);
