import db from '../db.ts';
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
// Node identity is stored as a `nodeRef` (`<hostId>~<nodeName>`, see nodeRef.js).
// Legacy rows may carry a bare node name, so all matching round-trips through
// decodeNodeRef rather than string comparison. The auto-published notice reuses
// the existing portal_notices table, marked with source='node_maintenance' so
// exit (manual or by timer) can find and close it.

const NOTICE_SOURCE = 'node_maintenance';

// A synthetic request for background/system-driven audit entries (auto-expire).
const SYSTEM_REQ = { session: { userId: null, username: 'system' }, ip: '' };

// Two node values refer to the same node when their bare names match and — when
// both carry a host id — those host ids agree. A bare-vs-encoded comparison
// matches on name only (best effort for legacy rows).
function nodesMatch(a, b) {
  const da = decodeNodeRef(a);
  const dbn = decodeNodeRef(b);
  if (!da.nodeName || !dbn.nodeName) return false;
  if (da.nodeName !== dbn.nodeName) return false;
  if (da.hostId && dbn.hostId) return da.hostId === dbn.hostId;
  return true;
}

function isExpired(until) {
  if (!until) return false;
  const t = new Date(until).getTime();
  if (Number.isNaN(t)) return false;
  return t <= Date.now();
}

// Human-friendly "until" — "18:00" today, "11 Jul 18:00" otherwise.
export function formatUntil(until) {
  if (!until) return '';
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return '';
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  if (d.toDateString() === new Date().toDateString()) return time;
  const day = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(d);
  return `${day} ${time}`;
}

// Normalize a user-supplied end time to an ISO string, or null when absent /
// unparseable / already in the past.
function normalizeUntil(until) {
  if (!until) return null;
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= Date.now()) return null;
  return d.toISOString();
}

export function serializeMaintenance(row) {
  if (!row) return null;
  const { hostId, nodeName, nodeRef } = decodeNodeRef(row.node_name);
  return {
    id: row.id,
    node: nodeName || row.node_name,
    nodeRef: nodeRef || row.node_name,
    hostId: row.pve_host_id ?? hostId ?? null,
    reason: row.reason || '',
    until: row.until || null,
    untilLabel: formatUntil(row.until),
    createdBy: row.created_by || '',
    createdAt: row.created_at || '',
  };
}

// All rows that are still active (not past their end time).
export function getActiveMaintenanceRows() {
  return db.prepare('SELECT * FROM node_maintenance ORDER BY created_at DESC, id DESC')
    .all()
    .filter((row) => !isExpired(row.until));
}

export function listMaintenance() {
  return getActiveMaintenanceRows().map(serializeMaintenance);
}

// The active maintenance row for a node, or null. Matching uses nodeRef
// round-tripping so both encoded and legacy bare node values resolve.
export function findMaintenanceForNode(nodeValue) {
  if (!nodeValue) return null;
  for (const row of getActiveMaintenanceRows()) {
    if (nodesMatch(row.node_name, nodeValue)) return row;
  }
  return null;
}

// Guard for the provisioning paths. Synchronous (better-sqlite3). Throws a
// 423 (Locked) error with a clear, user-facing message when the target node is
// draining, so the clone/create handlers surface it verbatim via sendError().
export function assertNodeAvailable(nodeValue) {
  const row = findMaintenanceForNode(nodeValue);
  if (!row) return;
  const { nodeName } = decodeNodeRef(row.node_name);
  const untilLabel = formatUntil(row.until);
  let message = `Node ${nodeName || row.node_name} is in maintenance`;
  if (untilLabel) message += ` until ~${untilLabel}`;
  if (row.reason) message += ` (${row.reason})`;
  message += '. New deployments to this node are blocked — pick another node. Running VMs are unaffected.';
  throw httpError(423, message);
}

function buildNoticeBody(nodeName, reason, until) {
  const untilLabel = formatUntil(until);
  let body = `${nodeName} is undergoing maintenance`;
  if (untilLabel) body += ` until ~${untilLabel}`;
  body += '.';
  if (reason) body += ` ${reason}`;
  body += ' New VMs cannot be deployed to this node during the window; running VMs are unaffected.';
  return body;
}

// Enter (or update) maintenance for a node. Upserts the maintenance row and its
// auto-published notice, then audit-logs the action.
export function enterMaintenance({ node, reason = '', until = null, req = SYSTEM_REQ }) {
  const { nodeName, nodeRef } = decodeNodeRef(node);
  if (!nodeName) throw httpError(400, 'A node is required');
  const { hostId } = decodeNodeRef(node);
  const normalizedUntil = normalizeUntil(until);
  const cleanReason = String(reason || '').trim();
  const createdBy = req.session?.username || '';

  const existing = findMaintenanceForNode(node);
  const noticeTitle = `Node maintenance — ${nodeName}`;
  const noticeBody = buildNoticeBody(nodeName, cleanReason, normalizedUntil);

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE node_maintenance SET reason = ?, until = ?, pve_host_id = ? WHERE id = ?')
        .run(cleanReason, normalizedUntil, hostId ?? existing.pve_host_id ?? null, existing.id);
      if (existing.notice_id) {
        db.prepare('UPDATE portal_notices SET title = ?, body = ?, level = ?, active = 1 WHERE id = ?')
          .run(noticeTitle, noticeBody, 'maintenance', existing.notice_id);
      }
      return existing.id;
    }
    const notice = db.prepare(
      'INSERT INTO portal_notices (title, body, level, active, source, created_by) VALUES (?, ?, ?, 1, ?, ?)'
    ).run(noticeTitle, noticeBody, 'maintenance', NOTICE_SOURCE, createdBy);
    const info = db.prepare(
      'INSERT INTO node_maintenance (pve_host_id, node_name, reason, until, notice_id, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(hostId ?? null, nodeRef || node, cleanReason, normalizedUntil, notice.lastInsertRowid, createdBy);
    return info.lastInsertRowid;
  });

  const id = tx();
  logAudit(req, existing ? 'node_maintenance_update' : 'node_maintenance_enter', nodeRef || node,
    `${cleanReason || 'no reason'}${normalizedUntil ? ` until ${normalizedUntil}` : ''}`);
  return serializeMaintenance(db.prepare('SELECT * FROM node_maintenance WHERE id = ?').get(id));
}

// Lift maintenance for a stored row: remove it and deactivate its notice.
function exitMaintenanceRow(row, req, { auto = false } = {}) {
  if (!row) return false;
  const tx = db.transaction(() => {
    if (row.notice_id) {
      db.prepare('UPDATE portal_notices SET active = 0 WHERE id = ?').run(row.notice_id);
    }
    // Belt-and-suspenders: close any lingering auto notice for this node.
    db.prepare('UPDATE portal_notices SET active = 0 WHERE source = ? AND active = 1 AND title = ?')
      .run(NOTICE_SOURCE, `Node maintenance — ${decodeNodeRef(row.node_name).nodeName}`);
    db.prepare('DELETE FROM node_maintenance WHERE id = ?').run(row.id);
  });
  tx();
  logAudit(req, auto ? 'node_maintenance_expire' : 'node_maintenance_exit', row.node_name || '',
    auto ? 'auto-expired' : '');
  return true;
}

export function exitMaintenanceById(id, req = SYSTEM_REQ) {
  const row = db.prepare('SELECT * FROM node_maintenance WHERE id = ?').get(id);
  if (!row) return false;
  return exitMaintenanceRow(row, req);
}

// Background sweep: lift any maintenance whose end time has passed and close its
// notice. Called from the startup tick in index.js.
export function sweepExpiredMaintenance() {
  const rows = db.prepare('SELECT * FROM node_maintenance').all();
  let lifted = 0;
  for (const row of rows) {
    if (isExpired(row.until)) {
      exitMaintenanceRow(row, SYSTEM_REQ, { auto: true });
      lifted += 1;
    }
  }
  return lifted;
}
