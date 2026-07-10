import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { assertSecretEncryptionKey, encryptSecret, secretNeedsMigration } from './utils/secrets.js';
// Safe circular import: permissions.js only touches the db binding inside
// functions, never at module-evaluation time.
import { PERMISSION_KEYS } from './utils/permissions.js';

const DB_PATH = process.env.DB_PATH || '/app/data/db.sqlite';
const INITIAL_ADMIN_USERNAME = process.env.INITIAL_ADMIN_USERNAME || '';
const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || '';

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vm_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(node, vmid)
  );

  CREATE TABLE IF NOT EXISTS vlans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tag INTEGER NOT NULL UNIQUE,
    mode TEXT DEFAULT 'managed',
    subnet_cidr TEXT DEFAULT '',
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_vlans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    vlan_id INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (vlan_id) REFERENCES vlans(id) ON DELETE CASCADE,
    UNIQUE(user_id, vlan_id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ssh_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    private_key TEXT NOT NULL,
    public_key TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS vm_ssh_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    host_fingerprint TEXT DEFAULT '',
    username TEXT DEFAULT 'root',
    UNIQUE(node, vmid)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    attempted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, attempted_at);
`);
// Lockout is keyed on (username, ip) so an anonymous attacker can't lock a
// user out of their own address by spamming bad passwords (targeted DoS).
try { db.exec("ALTER TABLE login_attempts ADD COLUMN ip TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(username, ip, attempted_at)'); } catch { /* exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS two_factor_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    attempted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_two_factor_attempts ON two_factor_attempts(username, attempted_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pve_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 8006,
    token_id TEXT NOT NULL,
    token_secret TEXT NOT NULL,
    verify_tls INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// PVE hosts are managed via the admin UI — no env seeding needed

// Migrations
try { db.exec(`
  CREATE TABLE IF NOT EXISTS vm_ssh_user_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    username TEXT DEFAULT 'root',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, node, vmid)
  )
`); } catch { /* exists */ }
try { db.exec("ALTER TABLE vm_ssh_configs ADD COLUMN host_fingerprint TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE vlans ADD COLUMN mode TEXT DEFAULT 'managed'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE vlans ADD COLUMN subnet_cidr TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN see_all_vms INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN require_2fa INTEGER DEFAULT 0'); } catch { /* exists */ }

// VM templates (admin registers which VMs are templates)
try { db.exec(`
  CREATE TABLE IF NOT EXISTS vm_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    default_cores INTEGER DEFAULT 2,
    default_memory INTEGER DEFAULT 2048,
    default_disk_gb INTEGER DEFAULT 20,
    default_storage TEXT DEFAULT 'local-lvm',
    cloud_init INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(node, vmid)
  )
`); } catch { /* exists */ }

// Cloud images (downloaded qcow2/raw cloud images used to build cloud-init templates)
try { db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    node TEXT NOT NULL,
    storage TEXT NOT NULL,
    volid TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    status TEXT DEFAULT 'downloading',
    status_detail TEXT DEFAULT '',
    upid TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch { /* exists */ }

// Track provisioned VMs
try { db.exec(`
  CREATE TABLE IF NOT EXISTS provisioned_vms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    name TEXT NOT NULL,
    template_id INTEGER,
    source_type TEXT DEFAULT 'template',
    cloud_image_id INTEGER,
    steps TEXT DEFAULT '',
    status TEXT DEFAULT 'creating',
    status_detail TEXT DEFAULT '',
    upid TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (template_id) REFERENCES vm_templates(id) ON DELETE SET NULL
  )
`); } catch { /* exists */ }
try { db.exec("ALTER TABLE provisioned_vms ADD COLUMN status_detail TEXT DEFAULT ''"); } catch { /* exists */ }
// Direct cloud-image provisioning + step-based deployment progress
try { db.exec("ALTER TABLE provisioned_vms ADD COLUMN source_type TEXT DEFAULT 'template'"); } catch { /* exists */ }
try { db.exec('ALTER TABLE provisioned_vms ADD COLUMN cloud_image_id INTEGER'); } catch { /* exists */ }
try { db.exec("ALTER TABLE provisioned_vms ADD COLUMN steps TEXT DEFAULT ''"); } catch { /* exists */ }
// Provisioning is finalized by in-process background pollers. A row left
// mid-flight ('cloning'/'creating'/'configuring') at startup was orphaned by a
// crash/restart and can never reach a terminal state — mark it interrupted so
// the UI stops spinning instead of waiting forever.
try {
  db.prepare(
    "UPDATE provisioned_vms SET status = 'error', status_detail = 'Provisioning was interrupted by a server restart — check the VM in Proxmox' WHERE status IN ('cloning', 'creating', 'configuring')"
  ).run();
} catch { /* table may not exist yet on a brand-new DB */ }

// Allow users to provision VMs (per-user permission)
try { db.exec('ALTER TABLE users ADD COLUMN can_provision INTEGER DEFAULT 0'); } catch { /* exists */ }

// Granular permissions (admin bypass all)
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_hosts INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_firewalls INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_port_forwards INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_vlans INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_policies INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_templates INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_users INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_assignments INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_view_audit_log INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_create_vms INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_edit_vm_hardware INTEGER DEFAULT 0'); } catch { /* exists */ }

// ─── Roles (RBAC) ─────────────────────────────────────────────────────────────
// A role is a named permission set; a user's effective permissions are their
// legacy per-user columns OR their role's permissions (see utils/permissions.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    built_in INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    UNIQUE(role_id, permission)
  );
`);
try { db.exec('ALTER TABLE users ADD COLUMN role_id INTEGER DEFAULT NULL'); } catch { /* exists */ }

// Resource quotas — NULL means unlimited (see utils/quota.js). Roles carry
// default quotas; a per-user value overrides the role's, per metric.
try { db.exec('ALTER TABLE users ADD COLUMN max_cores INTEGER DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN max_memory_gb INTEGER DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN max_storage_gb INTEGER DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE roles ADD COLUMN max_cores INTEGER DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE roles ADD COLUMN max_memory_gb INTEGER DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE roles ADD COLUMN max_storage_gb INTEGER DEFAULT NULL'); } catch { /* exists */ }

// Seed the built-in roles once (empty table = first run after this migration).
// "Administrator" grants every portal permission (it does NOT make the account
// an admin — is_admin stays a separate flag); "User" is the no-extra-perms base.
if (db.prepare('SELECT COUNT(*) AS c FROM roles').get().c === 0) {
  const adminRole = db.prepare(
    "INSERT INTO roles (name, description, built_in) VALUES ('Administrator', 'Every portal permission (does not grant admin account status)', 1)"
  ).run();
  const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
  for (const key of PERMISSION_KEYS) insertPerm.run(adminRole.lastInsertRowid, key);
  db.prepare(
    "INSERT INTO roles (name, description, built_in) VALUES ('User', 'Basic access — no extra permissions', 1)"
  ).run();
}

// Audit log
try { db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
`); } catch { /* exists */ }

// Firewalls (FortiGate etc.)
try { db.exec(`
  CREATE TABLE IF NOT EXISTS firewalls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'fortigate',
    host TEXT NOT NULL,
    port INTEGER DEFAULT 443,
    api_key TEXT NOT NULL,
    vdom TEXT DEFAULT 'root',
    parent_interface TEXT DEFAULT 'fortilink',
    wan_interface TEXT DEFAULT 'wan1',
    vlan_range_start INTEGER DEFAULT 1001,
    vlan_range_end INTEGER DEFAULT 1999,
    verify_tls INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch { /* exists */ }

try { db.exec('ALTER TABLE firewalls ADD COLUMN vlan_range_start INTEGER DEFAULT 1001'); } catch { /* exists */ }
try { db.exec('ALTER TABLE firewalls ADD COLUMN vlan_range_end INTEGER DEFAULT 1999'); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN lab_vdom_link TEXT DEFAULT 'lab-root0'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN root_vdom TEXT DEFAULT 'root'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN root_vdom_link TEXT DEFAULT 'lab-root1'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN route_gateway TEXT DEFAULT '10.255.254.2'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN trunk_switch_serial TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN trunk_switch_port TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec('ALTER TABLE pve_hosts ADD COLUMN verify_tls INTEGER DEFAULT 0'); } catch { /* exists */ }

// Track VLAN sync state with firewalls
try { db.exec(`
  CREATE TABLE IF NOT EXISTS firewall_vlan_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firewall_id INTEGER NOT NULL REFERENCES firewalls(id) ON DELETE CASCADE,
    vlan_id INTEGER NOT NULL REFERENCES vlans(id) ON DELETE CASCADE,
    interface_name TEXT NOT NULL,
    policy_ids TEXT DEFAULT '[]',
    dhcp_server_id INTEGER,
    synced_at TEXT DEFAULT (datetime('now')),
    UNIQUE(firewall_id, vlan_id)
  )
`); } catch { /* exists */ }

// Port forwarding: managed VIPs created through the UI
try { db.exec(`
  CREATE TABLE IF NOT EXISTS managed_vips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firewall_id INTEGER NOT NULL REFERENCES firewalls(id) ON DELETE CASCADE,
    vip_name TEXT NOT NULL,
    policy_id INTEGER,
    service_name TEXT DEFAULT '',
    protocol TEXT DEFAULT 'tcp',
    ext_port INTEGER NOT NULL,
    mapped_ip TEXT NOT NULL,
    mapped_port INTEGER NOT NULL,
    dst_interface TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(firewall_id, vip_name)
  )
`); } catch { /* exists */ }

try { db.exec("ALTER TABLE managed_vips ADD COLUMN service_name TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE managed_vips ADD COLUMN lab_policy_id INTEGER"); } catch { /* exists */ }
try { db.exec("ALTER TABLE managed_vips ADD COLUMN vlan_interface TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN external_ip TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE firewalls ADD COLUMN root_wan_zone TEXT DEFAULT 'underlay'"); } catch { /* exists */ }

// Landing page: admin-managed notices (maintenance windows etc.) and useful links
try { db.exec(`
  CREATE TABLE IF NOT EXISTS portal_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    level TEXT DEFAULT 'info',
    active INTEGER DEFAULT 1,
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch { /* exists */ }

try { db.exec(`
  CREATE TABLE IF NOT EXISTS portal_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch { /* exists */ }

// ─── Configurable FortiGate provisioning workflows (#16) ─────────────────────
// A workflow is an ordered, per-firewall+trigger list of whitelisted steps that
// replaces the old hardcoded provisioning chains. Runs record every created
// artifact so deprovision is artifact-based (reverse order), never re-derived.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firewall_id INTEGER NOT NULL REFERENCES firewalls(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 1,
    settings TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(firewall_id, trigger)
  )
`); } catch { /* exists */ }

try { db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    step_key TEXT DEFAULT '',
    action TEXT NOT NULL,
    label TEXT DEFAULT '',
    params TEXT DEFAULT '{}',
    condition TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    continue_on_error INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_wf ON workflow_steps(workflow_id, position);
`); } catch { /* exists */ }

try { db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
    firewall_id INTEGER,
    trigger TEXT DEFAULT '',
    subject_type TEXT DEFAULT '',
    subject_id TEXT DEFAULT '',
    subject_label TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    log TEXT DEFAULT '[]',
    artifacts TEXT DEFAULT '[]',
    dry_run INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_subject ON workflow_runs(firewall_id, subject_type, subject_id);
`); } catch { /* exists */ }

// Artifact-based teardown: record every object a sync/port-forward run created
// so deprovision removes exactly those (reverse order). Legacy rows have NULL
// artifacts and keep working through the original live-query deprovision path.
try { db.exec('ALTER TABLE firewall_vlan_sync ADD COLUMN artifacts TEXT DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE firewall_vlan_sync ADD COLUMN workflow_run_id INTEGER'); } catch { /* exists */ }
try { db.exec('ALTER TABLE managed_vips ADD COLUMN artifacts TEXT DEFAULT NULL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE managed_vips ADD COLUMN workflow_run_id INTEGER'); } catch { /* exists */ }

assertSecretEncryptionKey();

function migrateEncryptedColumn(table, idColumn, secretColumn, where = `${secretColumn} IS NOT NULL AND ${secretColumn} != ''`) {
  const rows = db.prepare(`SELECT ${idColumn} as id, ${secretColumn} as value FROM ${table} WHERE ${where}`).all();
  const update = db.prepare(`UPDATE ${table} SET ${secretColumn} = ? WHERE ${idColumn} = ?`);
  let migrated = 0;

  for (const row of rows) {
    if (!secretNeedsMigration(row.value)) continue;
    update.run(encryptSecret(row.value), row.id);
    migrated += 1;
  }

  return migrated;
}

const migrateSecrets = db.transaction(() => {
  const counts = {
    sshKeys: migrateEncryptedColumn('ssh_keys', 'id', 'private_key'),
    pveHosts: migrateEncryptedColumn('pve_hosts', 'id', 'token_secret'),
    users: migrateEncryptedColumn('users', 'id', 'totp_secret'),
    firewalls: migrateEncryptedColumn('firewalls', 'id', 'api_key'),
  };

  const pveTlsMigrationKey = 'pve_verify_tls_secure_default_v1';
  const pveTlsMigrated = db.prepare('SELECT value FROM settings WHERE key = ?').get(pveTlsMigrationKey);
  if (!pveTlsMigrated) {
    db.prepare("UPDATE pve_hosts SET verify_tls = 1 WHERE verify_tls = 0 AND created_at < '2026-03-12'").run();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(pveTlsMigrationKey, '1');
  }

  return counts;
});

const migratedSecrets = migrateSecrets();
const migratedSecretCount = Object.values(migratedSecrets).reduce((sum, count) => sum + count, 0);
if (migratedSecretCount > 0) {
  console.log(`[security] Encrypted ${migratedSecretCount} existing secret value(s) at rest`);
}

// Create default admin on first run
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  if (!INITIAL_ADMIN_USERNAME || !INITIAL_ADMIN_PASSWORD) {
    throw new Error(
      'No users exist in the database. Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD to bootstrap the first admin account.'
    );
  }

  const hash = bcrypt.hashSync(INITIAL_ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO users (username, password, is_admin) VALUES (?, ?, 1)').run(INITIAL_ADMIN_USERNAME, hash);
  console.log('========================================');
  console.log(`  Initial admin created: ${INITIAL_ADMIN_USERNAME}`);
  console.log('  Bootstrap credentials came from environment');
  console.log('========================================');
}

export default db;
