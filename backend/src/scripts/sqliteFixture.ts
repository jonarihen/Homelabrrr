// Synthetic OLD-format SQLite database for the importSqlite test. The legacy
// schema is built by the real legacy module (src/db.ts builds the full schema
// and bootstraps the admin at import time), spawned in a child process exactly
// like dbMigration.test.ts does; fixture rows exercising every import
// transform are then inserted on top.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Values the import test asserts round-trip exactly.
export const FIXTURE = {
  encryptionKey: '33'.repeat(32),
  adminUsername: 'admin',
  adminPassword: 'fixture-password-123',
  totpSecret: 'enc:v2:primary:AAAA.BBBB.CCCC',
  pveTokenSecret: 'enc:v2:primary:DDDD.EEEE.FFFF',
  firewallApiKey: 'enc:v2:primary:KKKK.LLLL.MMMM',
  webhookUrl: 'enc:v2:primary:NNNN.OOOO.PPPP',
  caddySshSecret: 'enc:v2:primary:QQQQ.RRRR.SSSS',
  leaseExpiresAt: '2026-12-31 23:59:59',
  invitePreset: { role_id: 1, vlan_ids: [1], is_admin: 0 },
  webauthnPublicKey: Buffer.from([1, 2, 3, 4, 5, 250, 251, 252]),
  webauthnTransports: ['usb'],
  webhookEventTypes: ['vm.created', 'vm.deleted'],
  workflowRunLog: [{ step: 'create_interface', ok: true }],
  policyIds: [12, 13],
  scheduleSkipUntil: 1_767_222_000_000,
  scheduleLastActionAt: 1_755_500_000_000,
  orphanRoleId: 9999,
  orphanUsername: 'orphan-role-user',
};

export function buildFixtureSqlite(path: string): void {
  // Build the legacy schema + admin bootstrap by importing the legacy module
  // in a child process (it does all of that at import time).
  const legacyModuleUrl = new URL('../db.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(legacyModuleUrl)})`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: path,
        SECRET_ENCRYPTION_KEY: FIXTURE.encryptionKey,
        SESSION_SECRET: 'fixture-session-secret',
        INITIAL_ADMIN_USERNAME: FIXTURE.adminUsername,
        INITIAL_ADMIN_PASSWORD: FIXTURE.adminPassword,
      },
    }
  );
  assert.equal(result.status, 0, `legacy db.ts bootstrap failed:\n${result.stderr || result.stdout}`);

  const db = new Database(path);
  try {
    const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(FIXTURE.adminUsername) as { id: number };

    // Role + role_permissions + a user carrying the role.
    const roleId = db.prepare(
      "INSERT INTO roles (name, description, built_in, max_cores) VALUES ('Importer', 'fixture role', 0, 4)"
    ).run().lastInsertRowid as number;
    const insertPermission = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    insertPermission.run(roleId, 'can_provision');
    insertPermission.run(roleId, 'can_manage_vlans');

    const operatorId = db.prepare(`
      INSERT INTO users (username, password, is_admin, see_all_vms, can_operate_all_vms, totp_secret,
                         totp_enabled, require_2fa, can_provision, notify_opt_out, role_id, max_cores)
      VALUES ('operator', '$2b$10$fixturefixturefixturefixturefixturefixturefixturefixtu', 0, 1, 0, ?, 1, 0, 1, 0, ?, 8)
    `).run(FIXTURE.totpSecret, roleId).lastInsertRowid as number;

    // Orphan: role_id points at a role that does not exist (the old schema had
    // no FK on users.role_id, so SQLite happily stored it).
    db.prepare(
      "INSERT INTO users (username, password, is_admin, role_id) VALUES (?, '$2b$10$orphanorphanorphanorphanorphanorphanorphanorphanorphan', 0, ?)"
    ).run(FIXTURE.orphanUsername, FIXTURE.orphanRoleId);

    // VLAN + membership.
    const vlanId = db.prepare(
      "INSERT INTO vlans (name, tag, mode, subnet_cidr, description) VALUES ('lab', 100, 'managed', '10.0.100.0/24', 'fixture vlan')"
    ).run().lastInsertRowid as number;
    db.prepare('INSERT INTO user_vlans (user_id, vlan_id) VALUES (?, ?)').run(operatorId, vlanId);

    // PVE host with an encrypted token secret.
    db.prepare(`
      INSERT INTO pve_hosts (name, host, port, token_id, token_secret, verify_tls, ssh_secret)
      VALUES ('pve1', '10.0.0.2', 8006, 'root@pam!portal', ?, 1, '')
    `).run(FIXTURE.pveTokenSecret);

    // Firewall (encrypted api_key) — parent of workflows and public IP pools.
    const firewallId = db.prepare(
      "INSERT INTO firewalls (name, type, host, port, api_key, verify_tls) VALUES ('fgt1', 'fortigate', '10.0.0.1', 443, ?, 0)"
    ).run(FIXTURE.firewallApiKey).lastInsertRowid as number;

    // Cloud image with the '' default_storage_map sentinel + a provisioned VM
    // referencing it (steps '' exercises empty-JSON → NULL).
    const cloudImageId = db.prepare(`
      INSERT INTO cloud_images (name, url, node, storage, volid, size, status, default_storage_map)
      VALUES ('debian-13', 'https://cloud.debian.org/debian-13.qcow2', '1~pve', 'local', 'local:import/debian-13.qcow2', 12345, 'ready', '')
    `).run().lastInsertRowid as number;
    db.prepare(`
      INSERT INTO provisioned_vms (user_id, node, vmid, name, source_type, cloud_image_id, steps, status)
      VALUES (?, '1~pve', 105, 'vm-105', 'cloudimage', ?, '', 'created')
    `).run(operatorId, cloudImageId);

    // Schedule: last_off -1 and days 127 must survive as numbers; skip_until /
    // last_action_at are epoch-ms pass-throughs.
    db.prepare(`
      INSERT INTO vm_schedules (node, vmid, enabled, stop_time, start_time, days, timezone, skip_until,
                                running_due_to_manual, stopped_this_window, last_off, last_action, last_action_at)
      VALUES ('1~pve', 105, 1, '22:00', '07:00', 127, 'Europe/Copenhagen', ?, 0, 0, -1, '', ?)
    `).run(FIXTURE.scheduleSkipUntil, FIXTURE.scheduleLastActionAt);

    // Lease with a SQLite 'YYYY-MM-DD HH:MM:SS' UTC timestamp.
    db.prepare(`
      INSERT INTO vm_leases (node, vmid, lease_days, expires_at, renewal_count, exempt, expired, created_by)
      VALUES ('1~pve', 105, 30, ?, 1, 0, 0, 'admin')
    `).run(FIXTURE.leaseExpiresAt);

    // Invite with a JSON preset.
    db.prepare(`
      INSERT INTO invites (token_hash, created_by, created_by_username, preset, require_2fa, expires_at)
      VALUES ('fixture-invite-hash', ?, 'admin', ?, 0, '2026-09-01 00:00:00')
    `).run(admin.id, JSON.stringify(FIXTURE.invitePreset));

    // Workflow chain: workflow → step → run (JSON log/artifacts), then rows
    // holding the new workflow_run_id references + jsonb policy_ids/artifacts.
    const workflowId = db.prepare(`
      INSERT INTO workflows (firewall_id, "trigger", name, enabled, is_default, settings)
      VALUES (?, 'vlan_sync', 'Default VLAN sync', 1, 1, '{"vlan_zone":"lab"}')
    `).run(firewallId).lastInsertRowid as number;
    db.prepare(`
      INSERT INTO workflow_steps (workflow_id, position, step_key, action, label, params, condition, enabled, continue_on_error)
      VALUES (?, 1, 'create-interface', 'create_interface', 'Create interface', '{"mtu":1500}', '', 1, 0)
    `).run(workflowId);
    const runId = db.prepare(`
      INSERT INTO workflow_runs (workflow_id, firewall_id, "trigger", subject_type, subject_id, subject_label, status, log, artifacts, dry_run)
      VALUES (?, ?, 'vlan_sync', 'vlan', '1', 'lab', 'success', ?, '["interface:lab100"]', 0)
    `).run(workflowId, firewallId, JSON.stringify(FIXTURE.workflowRunLog)).lastInsertRowid as number;
    db.prepare(`
      INSERT INTO firewall_vlan_sync (firewall_id, vlan_id, interface_name, policy_ids, dhcp_server_id, artifacts, workflow_run_id)
      VALUES (?, ?, 'lab100', ?, 7, '["policy:12"]', ?)
    `).run(firewallId, vlanId, JSON.stringify(FIXTURE.policyIds), runId);
    db.prepare(`
      INSERT INTO managed_vips (firewall_id, vip_name, policy_id, service_name, protocol, ext_port, mapped_ip, mapped_port, dst_interface, artifacts, workflow_run_id)
      VALUES (?, 'vip-web', 42, 'HTTPS', 'tcp', 443, '10.0.100.10', 443, 'lab100', '["vip:vip-web"]', ?)
    `).run(firewallId, runId);

    // Caddy server (encrypted ssh_secret) + site with the probe_at '' sentinel.
    const caddyServerId = db.prepare(`
      INSERT INTO caddy_servers (name, api_url, auth_type, auth_secret, verify_tls, ssh_host, ssh_user, ssh_auth_type, ssh_secret)
      VALUES ('edge', 'http://10.0.0.9:2019', 'none', '', 1, '10.0.0.9', 'caddy', 'key', ?)
    `).run(FIXTURE.caddySshSecret).lastInsertRowid as number;
    db.prepare(`
      INSERT INTO caddy_sites (server_id, domain, upstream_host, upstream_port, owner_user_id, status, steps, probe_status, probe_http_status, probe_at)
      VALUES (?, 'app.example.com', '10.0.100.10', 8080, ?, 'live', '', 'serving', 200, '')
    `).run(caddyServerId, operatorId);

    // WebAuthn credential: BLOB public key + JSON transports.
    db.prepare(`
      INSERT INTO webauthn_credentials (id, user_id, name, public_key, counter, transports, device_type, backed_up)
      VALUES ('fixture-cred', ?, 'YubiKey', ?, 7, ?, 'singleDevice', 0)
    `).run(operatorId, FIXTURE.webauthnPublicKey, JSON.stringify(FIXTURE.webauthnTransports));

    // Notification webhook: encrypted url + JSON event_types.
    db.prepare(
      "INSERT INTO notification_webhooks (name, url, event_types, enabled) VALUES ('discord', ?, ?, 1)"
    ).run(FIXTURE.webhookUrl, JSON.stringify(FIXTURE.webhookEventTypes));

    // Epoch-integer rate-limit rows.
    const insertAttempt = db.prepare('INSERT INTO login_attempts (username, ip, attempted_at) VALUES (?, ?, ?)');
    insertAttempt.run('admin', '10.0.0.50', Date.now() - 60_000);
    insertAttempt.run('admin', '10.0.0.50', Date.now() - 30_000);

    // Audit trail.
    db.prepare(`
      INSERT INTO audit_log (user_id, username, action, target, detail, ip)
      VALUES (?, 'admin', 'fixture.seed', 'import-test', 'seeded by sqliteFixture.ts', '127.0.0.1')
    `).run(admin.id);

    // Public IP chain: pool → address → assignment.
    const poolId = db.prepare(`
      INSERT INTO public_ip_pools (firewall_id, name, vdom, external_interface, gre_gateway, cidr, mtu, kill_switch_enabled, enabled)
      VALUES (?, 'gre-pool', 'root', 'gre-transit', '198.51.100.1', '203.0.113.0/29', 1476, 1, 1)
    `).run(firewallId).lastInsertRowid as number;
    const publicIpId = db.prepare(`
      INSERT INTO public_ips (pool_id, firewall_id, address, state) VALUES (?, ?, '203.0.113.2', 'assigned')
    `).run(poolId, firewallId).lastInsertRowid as number;
    db.prepare(`
      INSERT INTO public_ip_assignments (public_ip_id, firewall_id, user_id, proxmox_host_id, node, vmid, private_ip, status, egress_enabled)
      VALUES (?, ?, ?, 1, '1~pve', 105, '10.0.100.10', 'active', 1)
    `).run(publicIpId, firewallId, operatorId);
  } finally {
    db.close();
  }
}
