import { and, desc, eq, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/client.ts';
import { nodeMaintenance, portalNotices } from '../db/schema/index.ts';
import { decodeNodeRef } from './nodeRef.ts';
import { logAudit } from './audit.ts';
import { httpError } from './httpError.ts';

// ─── Node maintenance mode (soft drain) ──────────────────────────────────────
//
// An admin can flag a Proxmox node as "in maintenance". While active:
//   • all provisioning paths reject the node (see assertNodeAvailable)
//   • node pickers in the UI grey it out
//   • an Overview notice is auto-published so every user sees it at login
//   • Overview health renders it amber ("maintenance"), not red ("down")
// Running VMs are untouched — this is a soft drain, not an evacuation.
//
// Node identity is stored as a `nodeRef` (`<hostId>~<nodeName>`, see nodeRef.ts).
// Legacy rows may carry a bare node name, so all matching round-trips through
// decodeNodeRef rather than string comparison. The auto-published notice reuses
// the existing portal_notices table, marked with source='node_maintenance' so
// exit (manual or by timer) can find and close it.
//
// Concurrency: exit (admin action) races the 60s expiry ticker. The DELETE of
// the maintenance row is the atomic claim — whoever's DELETE reports rowCount 1
// closes the notice and writes the audit entry; the loser sees rowCount 0 and
// backs off. Enter re-checks for an existing row *inside* its transaction so
// the row it updates is the one it just observed.

const NOTICE_SOURCE = 'node_maintenance';

// A synthetic request for background/system-driven audit entries (auto-expire).
const SYSTEM_REQ = { session: { userId: null, username: 'system' }, ip: '' };

type MaintenanceRow = typeof nodeMaintenance.$inferSelect;

// Two node values refer to the same node when their bare names match and — when
// both carry a host id — those host ids agree. A bare-vs-encoded comparison
// matches on name only (best effort for legacy rows).
function nodesMatch(a: string, b: string): boolean {
  const da = decodeNodeRef(a);
  const dbn = decodeNodeRef(b);
  if (!da.nodeName || !dbn.nodeName) return false;
  if (da.nodeName !== dbn.nodeName) return false;
  if (da.hostId && dbn.hostId) return da.hostId === dbn.hostId;
  return true;
}

// Human-friendly "until" — "18:00" today, "11 Jul 18:00" otherwise.
export function formatUntil(until: Date | string | null | undefined): string {
  if (!until) return '';
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return '';
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  if (d.toDateString() === new Date().toDateString()) return time;
  const day = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(d);
  return `${day} ${time}`;
}

// Normalize a user-supplied end time to a Date, or null when absent /
// unparseable / already in the past.
function normalizeUntil(until: unknown): Date | null {
  if (!until) return null;
  const d = new Date(until as string | number | Date);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= Date.now()) return null;
  return d;
}

export function serializeMaintenance(row: MaintenanceRow | null | undefined) {
  if (!row) return null;
  const { hostId, nodeName, nodeRef } = decodeNodeRef(row.node_name);
  return {
    id: row.id,
    node: nodeName || row.node_name,
    nodeRef: nodeRef || row.node_name,
    hostId: row.pve_host_id ?? hostId ?? null,
    reason: row.reason || '',
    // Dates serialize to ISO strings in the JSON response — same wire contract.
    until: row.until || null,
    untilLabel: formatUntil(row.until),
    createdBy: row.created_by || '',
    createdAt: row.created_at || '',
  };
}

// All rows that are still active. Expiry filtering happens in SQL now
// (`until IS NULL OR until > now()`, DB clock) rather than a JS post-filter;
// timestamptz rows can no longer be unparseable, so the old "treat garbage
// dates as not expired" branch is gone with nothing to replace it.
export async function getActiveMaintenanceRows(executor: DbOrTx = db): Promise<MaintenanceRow[]> {
  return executor
    .select()
    .from(nodeMaintenance)
    .where(sql`${nodeMaintenance.until} IS NULL OR ${nodeMaintenance.until} > now()`)
    .orderBy(desc(nodeMaintenance.created_at), desc(nodeMaintenance.id));
}

export async function listMaintenance() {
  return (await getActiveMaintenanceRows()).map(serializeMaintenance);
}

// The active maintenance row for a node, or null. Matching uses nodeRef
// round-tripping so both encoded and legacy bare node values resolve — which
// is why this stays a JS scan over the (tiny) active set rather than a WHERE.
export async function findMaintenanceForNode(nodeValue: string | null | undefined, executor: DbOrTx = db): Promise<MaintenanceRow | null> {
  if (!nodeValue) return null;
  for (const row of await getActiveMaintenanceRows(executor)) {
    if (nodesMatch(row.node_name, nodeValue)) return row;
  }
  return null;
}

// Guard for the provisioning paths. Throws a 423 (Locked) error with a clear,
// user-facing message when the target node is draining, so the clone/create
// handlers surface it verbatim via sendError().
export async function assertNodeAvailable(nodeValue: string | null | undefined): Promise<void> {
  const row = await findMaintenanceForNode(nodeValue);
  if (!row) return;
  const { nodeName } = decodeNodeRef(row.node_name);
  const untilLabel = formatUntil(row.until);
  let message = `Node ${nodeName || row.node_name} is in maintenance`;
  if (untilLabel) message += ` until ~${untilLabel}`;
  if (row.reason) message += ` (${row.reason})`;
  message += '. New deployments to this node are blocked — pick another node. Running VMs are unaffected.';
  throw httpError(423, message);
}

function buildNoticeBody(nodeName: string, reason: string, until: Date | null): string {
  const untilLabel = formatUntil(until);
  let body = `${nodeName} is undergoing maintenance`;
  if (untilLabel) body += ` until ~${untilLabel}`;
  body += '.';
  if (reason) body += ` ${reason}`;
  body += ' New VMs cannot be deployed to this node during the window; running VMs are unaffected.';
  return body;
}

// Enter (or update) maintenance for a node. Upserts the maintenance row and its
// auto-published notice, then audit-logs the action. The existing-row check
// runs inside the transaction (not before it) so the update targets the row
// observed in the same transaction rather than a stale pre-check.
export async function enterMaintenance({ node, reason = '', until = null, req = SYSTEM_REQ }: {
  node: string; reason?: string; until?: unknown; req?: any;
}) {
  const { hostId, nodeName, nodeRef } = decodeNodeRef(node);
  if (!nodeName) throw httpError(400, 'A node is required');
  const normalizedUntil = normalizeUntil(until);
  const cleanReason = String(reason || '').trim();
  const createdBy = req.session?.username || '';

  const noticeTitle = `Node maintenance — ${nodeName}`;
  const noticeBody = buildNoticeBody(nodeName, cleanReason, normalizedUntil);

  const { id, updated } = await db.transaction(async (tx) => {
    const existing = await findMaintenanceForNode(node, tx);
    if (existing) {
      await tx.update(nodeMaintenance)
        .set({ reason: cleanReason, until: normalizedUntil, pve_host_id: hostId ?? existing.pve_host_id ?? null })
        .where(eq(nodeMaintenance.id, existing.id));
      if (existing.notice_id) {
        await tx.update(portalNotices)
          .set({ title: noticeTitle, body: noticeBody, level: 'maintenance', active: true })
          .where(eq(portalNotices.id, existing.notice_id));
      }
      return { id: existing.id, updated: true };
    }
    const [notice] = await tx.insert(portalNotices)
      .values({ title: noticeTitle, body: noticeBody, level: 'maintenance', active: true, source: NOTICE_SOURCE, created_by: createdBy })
      .returning({ id: portalNotices.id });
    const [inserted] = await tx.insert(nodeMaintenance)
      .values({ pve_host_id: hostId ?? null, node_name: nodeRef || node, reason: cleanReason, until: normalizedUntil, notice_id: notice.id, created_by: createdBy })
      .returning({ id: nodeMaintenance.id });
    return { id: inserted.id, updated: false };
  });

  await logAudit(req, updated ? 'node_maintenance_update' : 'node_maintenance_enter', nodeRef || node,
    `${cleanReason || 'no reason'}${normalizedUntil ? ` until ${normalizedUntil.toISOString()}` : ''}`);
  const [row] = await db.select().from(nodeMaintenance).where(eq(nodeMaintenance.id, id)).limit(1);
  return serializeMaintenance(row);
}

// Lift maintenance for a stored row: remove it and deactivate its notice.
// The DELETE is the atomic claim — rowCount 0 means another actor (admin exit
// vs the 60s expiry ticker) already closed this row, so we neither touch the
// notices nor write a duplicate audit entry.
async function exitMaintenanceRow(row: MaintenanceRow | null | undefined, req: any, { auto = false } = {}): Promise<boolean> {
  if (!row) return false;
  const claimed = await db.transaction(async (tx) => {
    const result = await tx.delete(nodeMaintenance).where(eq(nodeMaintenance.id, row.id));
    if ((result.rowCount ?? 0) === 0) return false;
    if (row.notice_id) {
      await tx.update(portalNotices).set({ active: false }).where(eq(portalNotices.id, row.notice_id));
    }
    // Belt-and-suspenders: close any lingering auto notice for this node.
    await tx.update(portalNotices)
      .set({ active: false })
      .where(and(
        eq(portalNotices.source, NOTICE_SOURCE),
        eq(portalNotices.active, true),
        eq(portalNotices.title, `Node maintenance — ${decodeNodeRef(row.node_name).nodeName}`),
      ));
    return true;
  });
  if (!claimed) return false;
  await logAudit(req, auto ? 'node_maintenance_expire' : 'node_maintenance_exit', row.node_name || '',
    auto ? 'auto-expired' : '');
  return true;
}

export async function exitMaintenanceById(id: number, req: any = SYSTEM_REQ): Promise<boolean> {
  const [row] = await db.select().from(nodeMaintenance).where(eq(nodeMaintenance.id, id)).limit(1);
  if (!row) return false;
  return exitMaintenanceRow(row, req);
}

// Background sweep: lift any maintenance whose end time has passed and close its
// notice. Called from the startup tick in index.ts. Expired rows are selected
// in SQL (`until <= now()`; a NULL until is open-ended and never matches), and
// the claim guard in exitMaintenanceRow keeps the count honest when an admin
// exit races the sweep.
export async function sweepExpiredMaintenance(): Promise<number> {
  const rows = await db.select().from(nodeMaintenance).where(sql`${nodeMaintenance.until} <= now()`);
  let lifted = 0;
  for (const row of rows) {
    if (await exitMaintenanceRow(row, SYSTEM_REQ, { auto: true })) lifted += 1;
  }
  return lifted;
}
