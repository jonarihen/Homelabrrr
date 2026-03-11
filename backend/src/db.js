import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

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
    username TEXT DEFAULT 'root',
    UNIQUE(node, vmid)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    attempted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, attempted_at);
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

// Track provisioned VMs
try { db.exec(`
  CREATE TABLE IF NOT EXISTS provisioned_vms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    name TEXT NOT NULL,
    template_id INTEGER,
    status TEXT DEFAULT 'creating',
    upid TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (template_id) REFERENCES vm_templates(id) ON DELETE SET NULL
  )
`); } catch { /* exists */ }

// Allow users to provision VMs (per-user permission)
try { db.exec('ALTER TABLE users ADD COLUMN can_provision INTEGER DEFAULT 0'); } catch { /* exists */ }

// Granular permissions (admin bypass all)
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_hosts INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_firewalls INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_vlans INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_policies INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_templates INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_users INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_assignments INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN can_view_audit_log INTEGER DEFAULT 0'); } catch { /* exists */ }

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
    verify_tls INTEGER DEFAULT 0,
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
