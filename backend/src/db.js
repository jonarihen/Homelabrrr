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
// Admin-defined default *target* storage for VMs deployed directly from this
// image (distinct from `storage`, which is where the image file downloaded).
// Empty ⇒ no default; the provisioning form auto-picks as before.
try { db.exec("ALTER TABLE cloud_images ADD COLUMN default_storage TEXT DEFAULT ''"); } catch { /* exists */ }
// Per-host default *target* storage for images on shared storage: pool names
// differ per host, so a single default can't serve every host the image can
// deploy to. JSON object keyed by pve_hosts.id → storage id, e.g.
// {"1":"bank-ssd","3":"ssdpool"}. `default_storage` remains the fallback.
try { db.exec("ALTER TABLE cloud_images ADD COLUMN default_storage_map TEXT DEFAULT ''"); } catch { /* exists */ }
// Console OSC patch: systemd v257+ images ship an OSC 3008 shell drop-in that
// spams the Proxmox VT console (which can't parse the sequences). An admin can
// patch the stored image (virt-customize over host SSH) to disable it. Tracks
// the patch state so the UI can badge it. Status: ''|'patching'|'patched'|'error'.
try { db.exec("ALTER TABLE cloud_images ADD COLUMN console_patch_status TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE cloud_images ADD COLUMN console_patch_detail TEXT DEFAULT ''"); } catch { /* exists */ }

// ISO catalog (installer ISOs downloaded onto a PVE storage as `iso` content)
try { db.exec(`
  CREATE TABLE IF NOT EXISTS isos (
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

// ISO downloads are finalized by an in-process background poller too — a row
// still 'downloading' at startup was orphaned by a restart and can never
// finish, so mark it errored instead of spinning forever in the UI.
try {
  db.prepare(
    "UPDATE isos SET status = 'error', status_detail = 'Download was interrupted by a server restart — remove it and add it again' WHERE status = 'downloading'"
  ).run();
} catch { /* table may not exist yet on a brand-new DB */ }

// Cross-host VM migrations (admin moves a guest between separate PVE hosts).
// Rows deliberately stay 'running' across backend restarts: the migration task
// keeps running on the source host regardless, and the /api/migrate status
// endpoints re-check the task lazily and finalize (re-point DB node refs) then.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS vm_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    vmid INTEGER NOT NULL,
    name TEXT DEFAULT '',
    vmtype TEXT DEFAULT 'qemu',
    source_node TEXT NOT NULL,
    target_node TEXT NOT NULL,
    target_storage TEXT DEFAULT '',
    target_bridge TEXT DEFAULT '',
    online INTEGER DEFAULT 0,
    delete_source INTEGER DEFAULT 1,
    status TEXT DEFAULT 'running',
    status_detail TEXT DEFAULT '',
    upid TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT DEFAULT NULL
  )
`); } catch { /* exists */ }
// Shared-storage aware migration: 'adopt' mode re-references disks that live on
// storage both hosts mount (NFS/CIFS) instead of copying them. kept_source
// marks migrations whose source VM config had to stay behind (PVE cannot
// forget a VM without destroying its disks) — deletion of those is guarded.
try { db.exec("ALTER TABLE vm_migrations ADD COLUMN mode TEXT DEFAULT 'remote_migrate'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE vm_migrations ADD COLUMN steps TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec('ALTER TABLE vm_migrations ADD COLUMN kept_source INTEGER DEFAULT 0'); } catch { /* exists */ }
// Disk-transfer progress scraped from the PVE task log (percent + the current
// "X of Y" line). log_offset is the last task-log line already read, so the
// poller resumes forward-only reading after a backend restart.
try { db.exec('ALTER TABLE vm_migrations ADD COLUMN progress REAL'); } catch { /* exists */ }
try { db.exec("ALTER TABLE vm_migrations ADD COLUMN progress_detail TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec('ALTER TABLE vm_migrations ADD COLUMN log_offset INTEGER DEFAULT 0'); } catch { /* exists */ }
// remote_migrate rows survive restarts (the PVE task keeps running and the
// status endpoints finalize lazily), but adopt-mode rows are orchestrated
// in-process — a restart mid-flight orphans them.
try {
  db.prepare(
    "UPDATE vm_migrations SET status = 'error', status_detail = 'Migration was interrupted by a server restart — verify the VM state in Proxmox before retrying', finished_at = datetime('now') WHERE status = 'running' AND mode = 'adopt'"
  ).run();
} catch { /* table may not exist yet on a brand-new DB */ }

// Manual vzdump backups. Proxmox lists the archive it is writing as soon as it
// creates the file, so without this the portal shows a half-written backup as a
// finished one. Rows deliberately stay 'running' across backend restarts — the
// vzdump task keeps going on the node regardless, and /api/vms/.../backup-tasks
// re-checks it lazily and finalizes then, exactly like vm_migrations.
// started_epoch is the task's start time in unix seconds off the *PVE node's*
// clock (parsed from the UPID), which is what archive ctimes are compared with.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS backup_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    upid TEXT NOT NULL,
    storage TEXT DEFAULT '',
    status TEXT DEFAULT 'running',
    status_detail TEXT DEFAULT '',
    progress REAL,
    progress_detail TEXT DEFAULT '',
    log_offset INTEGER DEFAULT 0,
    started_epoch INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT DEFAULT NULL
  )
`); } catch { /* exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_backup_tasks_vm ON backup_tasks (node, vmid)'); } catch { /* exists */ }

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
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_websites INTEGER DEFAULT 0'); } catch { /* exists */ }

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

// Optional root SSH per PVE host, used only for the one hypervisor task the
// API cannot do: removing a leftover VM config file after a shared-storage
// migration (qm destroy would erase the shared disks the moved VM still uses).
// ssh_secret is encrypted at rest; ssh_host_key pins the fingerprint on first use.
try { db.exec("ALTER TABLE pve_hosts ADD COLUMN ssh_host TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec('ALTER TABLE pve_hosts ADD COLUMN ssh_port INTEGER DEFAULT 22'); } catch { /* exists */ }
try { db.exec("ALTER TABLE pve_hosts ADD COLUMN ssh_user TEXT DEFAULT 'root'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE pve_hosts ADD COLUMN ssh_auth_type TEXT DEFAULT 'key'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE pve_hosts ADD COLUMN ssh_secret TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE pve_hosts ADD COLUMN ssh_host_key TEXT DEFAULT ''"); } catch { /* exists */ }

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

// Personal API tokens — Bearer-token auth for scripting against the portal.
// Only the SHA-256 hash of the secret is stored; the plaintext is shown once
// on creation and never persisted. A token is never more powerful than its
// owner: the live user is resolved on every request.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT DEFAULT NULL,
    last_used_at TEXT DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
`); } catch { /* exists */ }

// Rate-limit failed Bearer-token authentication attempts (per client IP),
// mirroring the login_attempts throttle.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS token_auth_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    attempted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_token_auth_attempts ON token_auth_attempts(ip, attempted_at);
`); } catch { /* exists */ }

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

// Storage pool exposure: admins choose which Proxmox storage pools users may
// pick when creating VMs / editing disks. A pool with NO row here is treated as
// exposed (default-open), so existing deployments see zero behavior change until
// an admin explicitly hides a pool — no async migration-time seeding required.
// Rows are keyed by (pve_host_id, storage): Proxmox storage ids are unique per
// host and shared across its nodes.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS storage_visibility (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pve_host_id INTEGER NOT NULL REFERENCES pve_hosts(id) ON DELETE CASCADE,
    storage TEXT NOT NULL,
    exposed INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(pve_host_id, storage)
  )
`); } catch { /* exists */ }

// Marks notices auto-published by a subsystem (e.g. node maintenance) so they
// can be found and closed automatically — '' means an admin-authored notice.
try { db.exec("ALTER TABLE portal_notices ADD COLUMN source TEXT DEFAULT ''"); } catch { /* exists */ }

// Node maintenance mode (soft drain). node_name holds a nodeRef ('<hostId>~<node>')
// via the nodeRef encoding; legacy bare names are matched with nodeLookupCandidates.
// notice_id links the auto-published portal_notices row so exit can close it.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS node_maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pve_host_id INTEGER,
    node_name TEXT NOT NULL,
    reason TEXT DEFAULT '',
    until TEXT DEFAULT NULL,
    notice_id INTEGER,
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch { /* exists */ }

// Discord / webhook notifications: admin-configured channels + per-event
// routing. The webhook URL is a bearer secret (whoever holds it can post to the
// channel), so it is encrypted at rest with encryptSecret — see utils/notify.js.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS notification_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    event_types TEXT DEFAULT '[]',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch { /* exists */ }

// Invite links: one-time self-registration tokens. We store only a HASH of the
// raw token (never the token itself — the raw value is shown to the admin once
// and discarded), the same discipline as PVE tokens / API keys elsewhere.
// `preset` is a generic JSON blob holding the role id, is_admin flag, the
// legacy per-user can_* permission columns, the quota numbers, and the VLAN ids
// to apply verbatim when the invite is redeemed. Modelling the preset as JSON
// keeps it decoupled from the roles (#14) / quota (#18) schema — whatever a
// preset holds is applied as-is at redemption time.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER,
    created_by_username TEXT DEFAULT '',
    preset TEXT NOT NULL DEFAULT '{}',
    require_2fa INTEGER DEFAULT 0,
    expires_at TEXT,
    used_at TEXT,
    used_by INTEGER,
    used_by_username TEXT DEFAULT '',
    revoked_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
  )
`); } catch { /* exists */ }

// VM leases — per-VM TTL so the lab doesn't fill with zombie VMs. Keyed on
// (node, vmid) rather than a provisioned_vms.id so leases also cover VMs that
// were assigned/claimed outside the provisioning flow (pre-portal VMs). A lease
// starts at provisioning; on expiry the background checker gracefully stops
// (never deletes) the VM, flags it expired, and — after a grace period — the
// admin reclaimable list surfaces it for manual deletion. `expires_at` NULL =
// unlimited; `exempt` = infra VM that never expires. Timestamps are stored in
// SQLite's UTC 'YYYY-MM-DD HH:MM:SS' form (parse as UTC on read).
try { db.exec(`
  CREATE TABLE IF NOT EXISTS vm_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    lease_days INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    renewal_count INTEGER DEFAULT 0,
    last_renewed_at TEXT,
    exempt INTEGER DEFAULT 0,
    expired INTEGER DEFAULT 0,
    expired_at TEXT,
    auto_stopped INTEGER DEFAULT 0,
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(node, vmid)
  )
`); } catch { /* exists */ }
// Per-user opt-out for notifications about the user's own resources (default
// opted-in). Owner-scoped events are suppressed when this is 1.
try { db.exec('ALTER TABLE users ADD COLUMN notify_opt_out INTEGER DEFAULT 0'); } catch { /* exists */ }
// Per-VM power schedules — automatic stop/start windows enforced by the
// background scheduler loop (scheduler.js). `days` is a 7-bit mask
// (bit 0 = Sunday … bit 6 = Saturday) of the days the STOP fires on;
// `timezone` is an IANA zone evaluated with Intl. `skip_until` is an epoch-ms
// "skip tonight" one-off. The remaining columns are scheduler bookkeeping:
// `last_off` is the previous tick's off-window state (edge detection across
// restarts), `stopped_this_window` records that the scheduler already stopped
// the VM for the current window, and `running_due_to_manual` marks that a
// manual start inside the off-window should be respected until the next stop.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS vm_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    enabled INTEGER DEFAULT 1,
    stop_time TEXT DEFAULT '',
    start_time TEXT DEFAULT '',
    days INTEGER DEFAULT 127,
    timezone TEXT DEFAULT 'UTC',
    skip_until INTEGER DEFAULT 0,
    running_due_to_manual INTEGER DEFAULT 0,
    stopped_this_window INTEGER DEFAULT 0,
    last_off INTEGER DEFAULT -1,
    last_action TEXT DEFAULT '',
    last_action_at INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(node, vmid)
  )
`); } catch { /* exists */ }

// ─── Self-service website publishing (external Caddy + FortiGate SSL inspection) ──
// A registered Caddy server is driven through its admin API; sites are the
// individual reverse-proxy routes Homelabrrr owns (each tagged @id
// homelabrrr-<site-id> in Caddy so we only ever touch our own routes).
try { db.exec(`
  CREATE TABLE IF NOT EXISTS caddy_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_url TEXT NOT NULL,
    auth_type TEXT DEFAULT 'none',
    auth_secret TEXT DEFAULT '',
    server_name TEXT DEFAULT '',
    verify_tls INTEGER DEFAULT 1,
    wan_ip TEXT DEFAULT '',
    fortigate_id INTEGER,
    inspection_profile TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (fortigate_id) REFERENCES firewalls(id) ON DELETE SET NULL
  )
`); } catch { /* exists */ }

try { db.exec(`
  CREATE TABLE IF NOT EXISTS caddy_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    domain TEXT NOT NULL UNIQUE,
    upstream_host TEXT NOT NULL,
    upstream_port INTEGER NOT NULL DEFAULT 80,
    owner_user_id INTEGER,
    status TEXT DEFAULT 'pending',
    status_detail TEXT DEFAULT '',
    steps TEXT DEFAULT '',
    fortigate_id INTEGER,
    inspection_profile TEXT DEFAULT '',
    cert_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES caddy_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (fortigate_id) REFERENCES firewalls(id) ON DELETE SET NULL
  )
`); } catch { /* exists */ }

// Caddyfile sync (optional per server): when an SSH target is configured,
// Homelabrrr maintains a snippet file on the Caddy host (imported by the main
// Caddyfile) instead of pushing ephemeral admin-API routes — so `caddy reload`
// / restarts never drop portal-published sites. ssh_secret is encrypted at
// rest; ssh_host_key pins the host fingerprint on first use.
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN ssh_host TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec('ALTER TABLE caddy_servers ADD COLUMN ssh_port INTEGER DEFAULT 22'); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN ssh_user TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN ssh_auth_type TEXT DEFAULT 'key'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN ssh_secret TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN ssh_host_key TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN snippet_path TEXT DEFAULT '/etc/caddy/homelabrrr.caddy'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN caddyfile_path TEXT DEFAULT '/etc/caddy/Caddyfile'"); } catch { /* exists */ }

// Imported sites (pulled from an existing Caddyfile via the admin API):
// managed=0 rows mirror routes that live in the Caddyfile — Homelabrrr never
// pushes, edits, or deletes those routes in Caddy, only tracks them. `kind`
// records the route type (reverse_proxy / file_server / static) and `wildcard`
// the covering wildcard site block (e.g. *.example.com), which is also set on
// managed sites published underneath a wildcard block.
try { db.exec("ALTER TABLE caddy_sites ADD COLUMN managed INTEGER DEFAULT 1"); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_sites ADD COLUMN kind TEXT DEFAULT 'reverse_proxy'"); } catch { /* exists */ }
try { db.exec("ALTER TABLE caddy_sites ADD COLUMN wildcard TEXT DEFAULT ''"); } catch { /* exists */ }

// caddy-forticertsync's inspection-bundle mode: one multi-SAN certificate on the
// FortiGate covering every published domain, instead of one certificate (and one
// of the profile's 10 server-cert slots) per site. When this holds the bundle's
// base name, publishing stops waiting for a per-site certificate to sync and
// stops writing to the inspection profile — the bundle already covers the new
// hostname through its wildcard SANs.
try { db.exec("ALTER TABLE caddy_servers ADD COLUMN inspection_bundle_cert TEXT DEFAULT ''"); } catch { /* exists */ }

// A publishing job left mid-flight at startup was orphaned by a crash/restart —
// mark it so the UI stops spinning (same reasoning as provisioned_vms above).
try {
  db.prepare(
    "UPDATE caddy_sites SET status = 'error', status_detail = 'Publishing was interrupted by a server restart — retry from the Websites page' WHERE status IN ('validating', 'pushing', 'issuing', 'inspecting')"
  ).run();
} catch { /* table may not exist yet on a brand-new DB */ }
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

// ─── Public IP pools, addresses and assignments ─────────────────────────────
//
// A pool is a routed public IPv4 prefix reachable through one firewall
// interface (in the validated design: a GRE transit interface in the root
// VDOM). Individual addresses out of that prefix can be handed to a user and
// one of their VM/private-IP targets, which lets several users each publish the
// same well-known port on their own public address.
//
// Creating these tables provisions nothing: no GRE tunnel, no route, no
// provider configuration is created or assumed by this schema.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS public_ip_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firewall_id INTEGER NOT NULL REFERENCES firewalls(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    vdom TEXT DEFAULT 'root',
    external_interface TEXT NOT NULL,
    gre_gateway TEXT DEFAULT '',
    lab_ingress_interface TEXT DEFAULT '',
    cidr TEXT DEFAULT '',
    mtu INTEGER,
    tcp_mss INTEGER,
    kill_switch_enabled INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(firewall_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_public_ip_pools_fw ON public_ip_pools(firewall_id);
`); } catch { /* exists */ }

// firewall_id is denormalized from the pool so UNIQUE(firewall_id, address) can
// be enforced by SQLite; a pool's firewall is immutable for exactly that reason.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS public_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_id INTEGER NOT NULL REFERENCES public_ip_pools(id) ON DELETE CASCADE,
    firewall_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'available',
    reserved_reason TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(pool_id, address),
    UNIQUE(firewall_id, address)
  );
  CREATE INDEX IF NOT EXISTS idx_public_ips_pool ON public_ips(pool_id);
  CREATE INDEX IF NOT EXISTS idx_public_ips_state ON public_ips(pool_id, state);
`); } catch { /* exists */ }

// One public address → one user → one VM/private-IP target. `node` carries the
// portal's "<hostId>~<nodeName>" reference (see utils/nodeRef.js);
// proxmox_host_id is the decoded host for convenience.
//
// The two uniqueness rules from the design are enforced as indexes: an address
// may back at most one assignment, and a private address may egress through at
// most one public IP per firewall. Releasing an assignment deletes the row.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS public_ip_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_ip_id INTEGER NOT NULL REFERENCES public_ips(id) ON DELETE CASCADE,
    firewall_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    proxmox_host_id INTEGER,
    node TEXT DEFAULT '',
    vmid INTEGER,
    private_ip TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_detail TEXT DEFAULT '',
    egress_enabled INTEGER DEFAULT 1,
    provision_run_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_public_ip_assignments_ip
    ON public_ip_assignments(public_ip_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_public_ip_assignments_egress
    ON public_ip_assignments(firewall_id, private_ip) WHERE egress_enabled = 1;
  CREATE INDEX IF NOT EXISTS idx_public_ip_assignments_user ON public_ip_assignments(user_id);
`); } catch { /* exists */ }

// Which public endpoint a port forward is published on. NULL keeps its historic
// meaning — the firewall's default WAN address — so every existing row stays
// valid and untouched, and legacy external-port conflicts keep being checked
// against that one default endpoint.
try { db.exec('ALTER TABLE managed_vips ADD COLUMN public_ip_id INTEGER'); } catch { /* exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_managed_vips_public_ip ON managed_vips(public_ip_id)'); } catch { /* exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_managed_vips_endpoint ON managed_vips(firewall_id, public_ip_id, protocol, ext_port)'); } catch { /* exists */ }

// Pools, addresses and assignments are administrative; port-forward permissions
// deliberately do not grant them.
try { db.exec('ALTER TABLE users ADD COLUMN can_manage_public_ips INTEGER DEFAULT 0'); } catch { /* exists */ }

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
    notificationWebhooks: migrateEncryptedColumn('notification_webhooks', 'id', 'url'),
    caddyServers: migrateEncryptedColumn('caddy_servers', 'id', 'auth_secret'),
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
