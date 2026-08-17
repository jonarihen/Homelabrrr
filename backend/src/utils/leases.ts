import db from '../db.ts';
import { getAllVMs, vmAction, lxcAction } from '../proxmox.ts';
import { nodeLookupCandidates } from './nodeRef.ts';

// ─── VM leases (per-VM TTL / expiry) ─────────────────────────────────────────
// A lease is a row in `vm_leases` keyed on (node, vmid). It starts at
// provisioning, can be renewed by the owner, and is swept by a background loop
// that gracefully stops (never deletes) VMs whose lease has expired. Settings
// live in the key/value `settings` table so admins can tune them at runtime.

const LEASE_DEFAULT_DAYS_KEY = 'lease_default_days';
const LEASE_GRACE_DAYS_KEY = 'lease_grace_days';
const DEFAULT_LEASE_DAYS = 30;
const DEFAULT_GRACE_DAYS = 7;

// How close to expiry (in days) before the countdown badge turns amber.
export const LEASE_EXPIRING_SOON_DAYS = 3;

const MS_PER_DAY = 86_400_000;

function readIntSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// SQLite stores datetime('now') as UTC 'YYYY-MM-DD HH:MM:SS'. Convert to a JS
// epoch by making it an ISO-8601 UTC string first.
function sqliteToMs(value) {
  if (!value) return null;
  const ms = Date.parse(`${String(value).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function getLeaseSettings() {
  return {
    defaultDays: readIntSetting(LEASE_DEFAULT_DAYS_KEY, DEFAULT_LEASE_DAYS),
    graceDays: readIntSetting(LEASE_GRACE_DAYS_KEY, DEFAULT_GRACE_DAYS),
  };
}

export function setLeaseSettings({ defaultDays, graceDays }) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  if (defaultDays !== undefined && defaultDays !== null) {
    const n = Math.max(0, Number.parseInt(defaultDays, 10) || 0);
    upsert.run(LEASE_DEFAULT_DAYS_KEY, String(n));
  }
  if (graceDays !== undefined && graceDays !== null) {
    const n = Math.max(0, Number.parseInt(graceDays, 10) || 0);
    upsert.run(LEASE_GRACE_DAYS_KEY, String(n));
  }
  return getLeaseSettings();
}

// Node values in vm_leases may be stored as a nodeRef ("1~pve") or a legacy
// bare node name, so always match through nodeLookupCandidates.
export function getLeaseRow(node, vmid) {
  const parsed = Number.parseInt(vmid, 10);
  if (!Number.isInteger(parsed)) return null;
  for (const candidate of nodeLookupCandidates(node)) {
    const row = db.prepare('SELECT * FROM vm_leases WHERE vmid = ? AND node = ? LIMIT 1').get(parsed, candidate);
    if (row) return row;
  }
  return null;
}

// Create a lease for a VM at provisioning time (no-op if one already exists).
// `leaseDays` overrides the configured default; 0 / unlimited → expires_at NULL.
export function createLeaseForVm(node, vmid, { createdBy = '', leaseDays } = {}) {
  const parsed = Number.parseInt(vmid, 10);
  if (!node || !Number.isInteger(parsed)) return null;

  const existing = getLeaseRow(node, vmid);
  if (existing) return existing;

  const { defaultDays } = getLeaseSettings();
  const requested = leaseDays !== undefined && leaseDays !== null ? Number.parseInt(leaseDays, 10) : defaultDays;
  const days = Number.isFinite(requested) && requested > 0 ? requested : 0; // 0 = unlimited

  try {
    if (days > 0) {
      db.prepare(`
        INSERT INTO vm_leases (node, vmid, lease_days, started_at, expires_at, created_by)
        VALUES (?, ?, ?, datetime('now'), datetime('now', ?), ?)
      `).run(String(node), parsed, days, `+${days} days`, createdBy || '');
    } else {
      db.prepare(`
        INSERT INTO vm_leases (node, vmid, lease_days, started_at, expires_at, created_by)
        VALUES (?, ?, 0, datetime('now'), NULL, ?)
      `).run(String(node), parsed, createdBy || '');
    }
  } catch { /* UNIQUE race — a lease already exists */ }

  return getLeaseRow(node, vmid);
}

// Owner-initiated renewal: reset the clock from now using the lease's own
// duration (falling back to the current default), bump the renewal count, and
// clear any expired/auto-stopped flags. Creates a lease first if none exists so
// a claimed pre-portal VM can still be given a lease.
export function renewLease(node, vmid, { createdBy = '' } = {}) {
  let row = getLeaseRow(node, vmid);
  if (!row) row = createLeaseForVm(node, vmid, { createdBy });
  if (!row) return null;

  const { defaultDays } = getLeaseSettings();
  const days = row.lease_days && row.lease_days > 0
    ? row.lease_days
    : (defaultDays > 0 ? defaultDays : 0);

  if (days > 0) {
    db.prepare(`
      UPDATE vm_leases
      SET started_at = datetime('now'), expires_at = datetime('now', ?), lease_days = ?,
          renewal_count = renewal_count + 1, last_renewed_at = datetime('now'),
          expired = 0, expired_at = NULL, auto_stopped = 0
      WHERE id = ?
    `).run(`+${days} days`, days, row.id);
  } else {
    db.prepare(`
      UPDATE vm_leases
      SET started_at = datetime('now'), expires_at = NULL, lease_days = 0,
          renewal_count = renewal_count + 1, last_renewed_at = datetime('now'),
          expired = 0, expired_at = NULL, auto_stopped = 0
      WHERE id = ?
    `).run(row.id);
  }
  return getLeaseRow(node, vmid);
}

// Admin adjustment: toggle exempt, set a new duration (recomputes expiry from
// now), and/or extend by N days from the current expiry. Any change clears the
// expired flag. Creates a lease if none exists.
export function updateLease(node, vmid, { exempt, leaseDays, extendDays, createdBy = '' } = {}) {
  let row = getLeaseRow(node, vmid);
  if (!row) row = createLeaseForVm(node, vmid, { createdBy });
  if (!row) return null;

  if (exempt !== undefined) {
    db.prepare("UPDATE vm_leases SET exempt = ?, expired = 0, expired_at = NULL, auto_stopped = 0 WHERE id = ?")
      .run(exempt ? 1 : 0, row.id);
  }

  if (leaseDays !== undefined && leaseDays !== null) {
    const days = Math.max(0, Number.parseInt(leaseDays, 10) || 0);
    if (days > 0) {
      db.prepare(`
        UPDATE vm_leases
        SET lease_days = ?, started_at = datetime('now'), expires_at = datetime('now', ?),
            expired = 0, expired_at = NULL, auto_stopped = 0
        WHERE id = ?
      `).run(days, `+${days} days`, row.id);
    } else {
      db.prepare("UPDATE vm_leases SET lease_days = 0, expires_at = NULL, expired = 0, expired_at = NULL, auto_stopped = 0 WHERE id = ?")
        .run(row.id);
    }
  }

  if (extendDays !== undefined && extendDays !== null) {
    const days = Number.parseInt(extendDays, 10) || 0;
    if (days !== 0) {
      // Extend from the later of the current expiry or now, so extending an
      // already-expired lease still lands in the future.
      const current = getLeaseRow(node, vmid);
      const base = current?.expires_at && sqliteToMs(current.expires_at) > Date.now()
        ? "expires_at"
        : "datetime('now')";
      db.prepare(`
        UPDATE vm_leases
        SET expires_at = datetime(${base}, ?), expired = 0, expired_at = NULL, auto_stopped = 0
        WHERE id = ?
      `).run(`${days >= 0 ? '+' : ''}${days} days`, row.id);
    }
  }

  return getLeaseRow(node, vmid);
}

// Derive a UI-friendly view from a raw lease row. `status` ∈
// exempt | unlimited | expired | expiring | active.
export function computeLeaseView(row, graceDays) {
  if (!row) return null;
  const g = graceDays ?? getLeaseSettings().graceDays;
  const now = Date.now();

  const view = {
    hasLease: true,
    exempt: row.exempt === 1,
    expired: row.expired === 1,
    autoStopped: row.auto_stopped === 1,
    leaseDays: row.lease_days,
    renewalCount: row.renewal_count || 0,
    startedAt: row.started_at || null,
    expiresAt: row.expires_at || null,
    lastRenewedAt: row.last_renewed_at || null,
    daysRemaining: null,
    reclaimable: false,
  };

  if (row.exempt === 1) { view.status = 'exempt'; return view; }
  if (!row.expires_at) { view.status = 'unlimited'; return view; }

  const expiresMs = sqliteToMs(row.expires_at);
  const msRemaining = expiresMs !== null ? expiresMs - now : 0;
  view.daysRemaining = Math.ceil(msRemaining / MS_PER_DAY);

  const graceMs = g * MS_PER_DAY;
  view.graceUntil = expiresMs !== null ? new Date(expiresMs + graceMs).toISOString() : null;
  view.reclaimable = row.expired === 1 && expiresMs !== null && (now - expiresMs) >= graceMs;

  if (row.expired === 1 || msRemaining <= 0) view.status = 'expired';
  else if (view.daysRemaining <= LEASE_EXPIRING_SOON_DAYS) view.status = 'expiring';
  else view.status = 'active';

  return view;
}

export function summarizeLease(node, vmid, graceDays) {
  const row = getLeaseRow(node, vmid);
  if (!row) return null;
  return computeLeaseView(row, graceDays);
}

// Fire-and-forget system audit entry (no `req` in the background loop).
export function logSystemAudit(action, target = '', detail = '') {
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, username, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(null, 'system', action, target, '', detail);
  } catch { /* audit is best-effort */ }
}

// Background sweep: find leases past their expiry (not exempt, not already
// flagged), gracefully shut down any that are still running, and flag them
// expired. Never deletes. Safe to call repeatedly.
export async function runLeaseSweep() {
  const due = db.prepare(`
    SELECT * FROM vm_leases
    WHERE exempt = 0 AND expired = 0 AND expires_at IS NOT NULL AND expires_at <= datetime('now')
  `).all();
  if (due.length === 0) return { checked: 0, stopped: 0 };

  let vms = [];
  try {
    vms = await getAllVMs();
  } catch (err) {
    console.warn(`[leases] sweep could not enumerate VMs: ${err.message}`);
    return { checked: 0, stopped: 0, error: err.message };
  }

  let stopped = 0;
  for (const lease of due) {
    // Guard every lease independently: a single failing row (a stuck upstream
    // call, a bad DB write) must never abort the sweep of the remaining ones.
    try {
      const candidates = nodeLookupCandidates(lease.node);
      const live = vms.find(v => Number(v.vmid) === lease.vmid
        && (candidates.includes(v.nodeRef) || candidates.includes(v.node)));

      let autoStopped = 0;
      if (live && live.status === 'running') {
        try {
          // Graceful ACPI shutdown — never a hard stop, never a delete.
          if (live.type === 'lxc') await lxcAction(lease.node, lease.vmid, 'shutdown');
          else await vmAction(lease.node, lease.vmid, 'shutdown');
          autoStopped = 1;
          stopped += 1;
          logSystemAudit('lease_expired_autostop', `${lease.node}/${lease.vmid}`, 'Lease expired — VM gracefully shut down');
        } catch (err) {
          logSystemAudit('lease_autostop_failed', `${lease.node}/${lease.vmid}`, err.message);
        }
      } else {
        logSystemAudit('lease_expired', `${lease.node}/${lease.vmid}`, live ? 'VM already stopped' : 'VM not found in cluster');
      }

      // Owners are notified in-app via the Overview (Dashboard) expiry notice,
      // which derives from each VM's lease status. Discord expiry warnings are a
      // separate feature (#22) and are deliberately not wired here.

      db.prepare("UPDATE vm_leases SET expired = 1, expired_at = datetime('now'), auto_stopped = ? WHERE id = ?")
        .run(autoStopped, lease.id);
    } catch (err) {
      logSystemAudit('lease_sweep_error', `${lease.node}/${lease.vmid}`, err.message);
    }
  }

  return { checked: due.length, stopped };
}

// One-off backfill: give every provisioned / assigned VM that lacks a lease the
// configured default. Lets leases start applying to VMs that predate the
// feature. Returns the number of leases created.
export function backfillLeases({ createdBy = '' } = {}) {
  const targets = db.prepare(`
    SELECT node, vmid FROM provisioned_vms
    UNION
    SELECT node, vmid FROM vm_assignments
  `).all();

  let created = 0;
  for (const t of targets) {
    if (getLeaseRow(t.node, t.vmid)) continue;
    if (createLeaseForVm(t.node, t.vmid, { createdBy })) created += 1;
  }
  return created;
}
