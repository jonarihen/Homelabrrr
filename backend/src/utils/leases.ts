import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { vmLeases, provisionedVms, vmAssignments, pveHosts } from '../db/schema/index.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { withVmMigrationLock, vmMigrationPending, withVmPolicyWrite, type PolicyActor } from './vmMigrationLock.ts';
import { logAuditEntry } from './audit.ts';
import { getAllVMs, vmAction, lxcAction, guestPresence } from '../proxmox.ts';
import { decodeNodeRef, nodeLookupCandidates } from './nodeRef.ts';

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

async function readIntSetting(key: string, fallback: number, database: DbOrTx = db): Promise<number> {
  const value = await getSetting(key, database);
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getLeaseSettings(database: DbOrTx = db) {
  return {
    defaultDays: await readIntSetting(LEASE_DEFAULT_DAYS_KEY, DEFAULT_LEASE_DAYS, database),
    graceDays: await readIntSetting(LEASE_GRACE_DAYS_KEY, DEFAULT_GRACE_DAYS, database),
  };
}

export async function setLeaseSettings({ defaultDays, graceDays }: { defaultDays?: unknown; graceDays?: unknown }) {
  if (defaultDays !== undefined && defaultDays !== null) {
    const n = Math.max(0, Number.parseInt(defaultDays as string, 10) || 0);
    await setSetting(LEASE_DEFAULT_DAYS_KEY, String(n));
  }
  if (graceDays !== undefined && graceDays !== null) {
    const n = Math.max(0, Number.parseInt(graceDays as string, 10) || 0);
    await setSetting(LEASE_GRACE_DAYS_KEY, String(n));
  }
  return getLeaseSettings();
}

// Node values in vm_leases may be stored as a nodeRef ("1~pve") or a legacy
// bare node name, so match through all nodeLookupCandidates in a single query,
// ordering the matches by candidate preference (nodeRef before bare name).
export async function getLeaseRow(node: unknown, vmid: unknown, database: DbOrTx = db) {
  const parsed = Number.parseInt(vmid as string, 10);
  if (!Number.isInteger(parsed)) return null;
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return null;

  const preference = sql`CASE ${vmLeases.node} ${sql.join(
    candidates.map((c, i) => sql`WHEN ${c} THEN ${i}`),
    sql` `,
  )} ELSE ${candidates.length} END`;

  const [row] = await database
    .select()
    .from(vmLeases)
    .where(and(eq(vmLeases.vmid, parsed), inArray(vmLeases.node, candidates)))
    .orderBy(preference)
    .limit(1);
  return row ?? null;
}

// Create a lease for a VM at provisioning time (no-op if one already exists).
// `leaseDays` overrides the configured default; 0 / unlimited → expires_at NULL.
export async function createLeaseForVm(node: unknown, vmid: unknown, { createdBy = '', leaseDays, actor }: { createdBy?: string; leaseDays?: unknown; actor?: PolicyActor } = {}) {
  const parsed = Number.parseInt(vmid as string, 10);
  if (!node || !Number.isInteger(parsed)) return null;

  return withVmPolicyWrite(node, parsed, (tx, currentNode) => createLeaseRow(tx, currentNode, parsed, { createdBy, leaseDays }), actor);
}

async function createLeaseRow(database: DbOrTx, node: unknown, parsed: number, { createdBy = '', leaseDays }: { createdBy?: string; leaseDays?: unknown } = {}) {
  const existing = await getLeaseRow(node, parsed, database);
  if (existing) return existing;

  const { defaultDays } = await getLeaseSettings(database);
  const requested = leaseDays !== undefined && leaseDays !== null ? Number.parseInt(leaseDays as string, 10) : defaultDays;
  const days = Number.isFinite(requested) && requested > 0 ? requested : 0; // 0 = unlimited

  await database.insert(vmLeases).values({
    node: String(node),
    vmid: parsed,
    lease_days: days,
    expires_at: days > 0 ? (sql`now() + make_interval(days => ${days})` as unknown as Date) : null,
    created_by: createdBy || '',
  }).onConflictDoNothing({ target: [vmLeases.node, vmLeases.vmid] });

  return getLeaseRow(node, parsed, database);
}

// Owner-initiated renewal: reset the clock from now using the lease's own
// duration (falling back to the current default), bump the renewal count, and
// clear any expired/auto-stopped flags. Creates a lease first if none exists so
// a claimed pre-portal VM can still be given a lease.
export async function renewLease(node: unknown, vmid: unknown, { createdBy = '', actor }: { createdBy?: string; actor?: PolicyActor } = {}) {
  const parsed = Number.parseInt(vmid as string, 10);
  if (!node || !Number.isInteger(parsed)) return null;
  return withVmPolicyWrite(node, parsed, async (database, currentNode) => {
    const row = await createLeaseRow(database, currentNode, parsed, { createdBy });
    if (!row) return null;

    const { defaultDays } = await getLeaseSettings(database);
    const days = row.lease_days && row.lease_days > 0
      ? row.lease_days
      : (defaultDays > 0 ? defaultDays : 0);

    await database.update(vmLeases).set({
      started_at: new Date(),
      expires_at: days > 0 ? (sql`now() + make_interval(days => ${days})` as unknown as Date) : null,
      lease_days: days,
      renewal_count: sql`${vmLeases.renewal_count} + 1`,
      last_renewed_at: new Date(),
      expired: false,
      expired_at: null,
      auto_stopped: false,
    }).where(eq(vmLeases.id, row.id));

    return getLeaseRow(currentNode, parsed, database);
  }, actor);
}

// Admin adjustment: toggle exempt, set a new duration (recomputes expiry from
// now), and/or extend by N days from the current expiry. Any change clears the
// expired flag. Creates a lease if none exists.
export async function updateLease(node: unknown, vmid: unknown, { exempt, leaseDays, extendDays, createdBy = '', actor }: { exempt?: unknown; leaseDays?: unknown; extendDays?: unknown; createdBy?: string; actor?: PolicyActor } = {}) {
  const parsed = Number.parseInt(vmid as string, 10);
  if (!node || !Number.isInteger(parsed)) return null;
  return withVmPolicyWrite(node, parsed, async (database, currentNode) => {
    const row = await createLeaseRow(database, currentNode, parsed, { createdBy });
    if (!row) return null;

    if (exempt !== undefined) {
      await database.update(vmLeases)
        .set({ exempt: Boolean(exempt), expired: false, expired_at: null, auto_stopped: false })
        .where(eq(vmLeases.id, row.id));
    }

    if (leaseDays !== undefined && leaseDays !== null) {
      const days = Math.max(0, Number.parseInt(leaseDays as string, 10) || 0);
      if (days > 0) {
        await database.update(vmLeases).set({
          lease_days: days,
          started_at: new Date(),
          expires_at: sql`now() + make_interval(days => ${days})` as unknown as Date,
          expired: false,
          expired_at: null,
          auto_stopped: false,
        }).where(eq(vmLeases.id, row.id));
      } else {
        await database.update(vmLeases)
          .set({ lease_days: 0, expires_at: null, expired: false, expired_at: null, auto_stopped: false })
          .where(eq(vmLeases.id, row.id));
      }
    }

    if (extendDays !== undefined && extendDays !== null) {
      const days = Number.parseInt(extendDays as string, 10) || 0;
      if (days !== 0) {
        await database.update(vmLeases).set({
          expires_at: sql`GREATEST(COALESCE(${vmLeases.expires_at}, now()), now()) + make_interval(days => ${days})` as unknown as Date,
          expired: false,
          expired_at: null,
          auto_stopped: false,
        }).where(eq(vmLeases.id, row.id));
      }
    }

    return getLeaseRow(currentNode, parsed, database);
  }, actor);
}

// Derive a UI-friendly view from a raw lease row. `status` ∈
// exempt | unlimited | expired | expiring | active.
export async function computeLeaseView(row: any, graceDays?: number) {
  if (!row) return null;
  const g = graceDays ?? (await getLeaseSettings()).graceDays;
  const now = Date.now();

  const view: any = {
    hasLease: true,
    exempt: Boolean(row.exempt),
    expired: Boolean(row.expired),
    autoStopped: Boolean(row.auto_stopped),
    leaseDays: row.lease_days,
    renewalCount: row.renewal_count || 0,
    startedAt: row.started_at || null,
    expiresAt: row.expires_at || null,
    lastRenewedAt: row.last_renewed_at || null,
    daysRemaining: null,
    reclaimable: false,
  };

  if (row.exempt) { view.status = 'exempt'; return view; }
  if (!row.expires_at) { view.status = 'unlimited'; return view; }

  // expires_at is a JS Date now (no more sqlite string parsing).
  const expiresMs = row.expires_at.getTime();
  const msRemaining = expiresMs - now;
  view.daysRemaining = Math.ceil(msRemaining / MS_PER_DAY);

  const graceMs = g * MS_PER_DAY;
  view.graceUntil = new Date(expiresMs + graceMs).toISOString();
  view.reclaimable = Boolean(row.expired) && (now - expiresMs) >= graceMs;

  if (row.expired || msRemaining <= 0) view.status = 'expired';
  else if (view.daysRemaining <= LEASE_EXPIRING_SOON_DAYS) view.status = 'expiring';
  else view.status = 'active';

  return view;
}

export async function summarizeLease(node: unknown, vmid: unknown, graceDays?: number) {
  const row = await getLeaseRow(node, vmid);
  if (!row) return null;
  return computeLeaseView(row, graceDays);
}

// Fire-and-forget system audit entry (no `req` in the background loop).
export async function logSystemAudit(action: string, target = '', detail = ''): Promise<void> {
  try {
    await logAuditEntry({ userId: null, username: 'system', action, target, detail });
  } catch { /* audit is best-effort */ }
}

// Background sweep: find leases past their expiry (not exempt, not already
// flagged), gracefully shut down any that are still running, and flag them
// expired. Never deletes. Safe to call repeatedly.
export async function runLeaseSweep() {
  // Expiry selection lives in SQL now: not exempt, not already flagged, and
  // expires_at set and already in the past.
  const due = await db
    .select()
    .from(vmLeases)
    .where(and(
      eq(vmLeases.exempt, false),
      eq(vmLeases.expired, false),
      isNotNull(vmLeases.expires_at),
      lt(vmLeases.expires_at, sql`now()`),
    ));
  if (due.length === 0) return { checked: 0, stopped: 0 };

  let vms: any[] = [];
  try {
    vms = await getAllVMs();
  } catch (err: any) {
    console.warn(`[leases] sweep could not enumerate VMs: ${err.message}`);
    return { checked: 0, stopped: 0, error: err.message };
  }

  let stopped = 0;
  for (const lease of due) {
    // Guard every lease independently: a single failing row (a stuck upstream
    // call, a bad DB write) must never abort the sweep of the remaining ones.
    try {
      const audits: [string, string, string][] = [];
      await withVmMigrationLock(lease.vmid, (database) => database.transaction(async (tx) => {
        if (await vmMigrationPending(tx, lease.vmid)) return;
        const [current] = await tx.select().from(vmLeases).where(eq(vmLeases.id, lease.id)).limit(1);
        if (!current || current.node !== lease.node || current.exempt || current.expired || !current.expires_at) return;
        if (current.expires_at.getTime() > Date.now()) return;
        if (lease.expires_at && current.expires_at.getTime() !== lease.expires_at.getTime()) return;

        const candidates = nodeLookupCandidates(current.node);
        const live = vms.find(v => Number(v.vmid) === current.vmid
          && (candidates.includes(v.nodeRef) || (decodeNodeRef(current.node).hostId === null && candidates.includes(v.node))));
        if (!live) {
          const { hostId } = decodeNodeRef(current.node);
          const [registered] = hostId === null ? [true] : await tx.select({ id: pveHosts.id }).from(pveHosts).where(eq(pveHosts.id, hostId));
          if (registered && await guestPresence(current.node, current.vmid, tx)) return;
        }
        const target = `${current.node}/${current.vmid}`;
        let autoStopped = false;
        if (live?.status === 'running') {
          try {
            if (live.type === 'lxc') await lxcAction(current.node, current.vmid, 'shutdown', tx);
            else await vmAction(current.node, current.vmid, 'shutdown', tx);
            autoStopped = true;
            stopped += 1;
            audits.push(['lease_expired_autostop', target, 'Lease expired — VM gracefully shut down']);
          } catch (err: any) {
            audits.push(['lease_autostop_failed', target, err.message]);
            return;
          }
        } else {
          audits.push(['lease_expired', target, live ? 'VM already stopped' : 'VM not found in cluster']);
        }

        const [latest] = await tx.select().from(vmLeases).where(eq(vmLeases.id, current.id)).for('update').limit(1);
        if (!latest || latest.node !== current.node || latest.expired || latest.exempt || !latest.expires_at) return;
        if (latest.expires_at.getTime() !== current.expires_at.getTime() || latest.expires_at.getTime() > Date.now()) return;
        await tx.update(vmLeases)
          .set({ expired: true, expired_at: new Date(), auto_stopped: autoStopped })
          .where(and(
            eq(vmLeases.id, current.id), eq(vmLeases.node, current.node),
            eq(vmLeases.expired, false), eq(vmLeases.exempt, false),
            sql`date_trunc('milliseconds', ${vmLeases.expires_at}) = ${current.expires_at}`,
          ));
      }), true);
      for (const [action, target, detail] of audits) await logSystemAudit(action, target, detail);
    } catch (err: any) {
      await logSystemAudit('lease_sweep_error', `${lease.node}/${lease.vmid}`, err.message);
    }
  }

  return { checked: due.length, stopped };
}

// One-off backfill: give every provisioned / assigned VM that lacks a lease the
// configured default. Lets leases start applying to VMs that predate the
// feature. Returns the number of leases created.
export async function backfillLeases({ createdBy = '', actor }: { createdBy?: string; actor?: PolicyActor } = {}) {
  const [provisioned, assigned] = await Promise.all([
    db.select({ node: provisionedVms.node, vmid: provisionedVms.vmid }).from(provisionedVms),
    db.select({ node: vmAssignments.node, vmid: vmAssignments.vmid }).from(vmAssignments),
  ]);

  // Dedupe the union of both sources on (node, vmid) — the old query used SQL UNION.
  const seen = new Set<string>();
  const targets: { node: string; vmid: number }[] = [];
  for (const t of [...provisioned, ...assigned]) {
    const key = `${t.node}/${t.vmid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(t);
  }

  let created = 0;
  for (const t of targets) {
    if (await getLeaseRow(t.node, t.vmid)) continue;
    if (await createLeaseForVm(t.node, t.vmid, { createdBy, actor })) created += 1;
  }
  return created;
}
