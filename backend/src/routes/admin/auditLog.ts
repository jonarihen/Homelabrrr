import { Router } from 'express';
import { and, eq, desc, gte, lt, asc, inArray, sql, count } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { auditLog } from '../../db/schema/index.ts';
import { logAudit } from '../../utils/audit.ts';
import { csvLine } from '../../utils/csv.ts';
import { pAudit } from './shared.ts';

const router = Router();

// ─── Audit Log ──────────────────────────────────────────────────────────────

// Shared by the paged list and the CSV export so both always apply the same
// filters. Dates are calendar days (YYYY-MM-DD, UTC); `to` includes its whole day.
const AUDIT_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Date.parse rolls 2026-02-30 into March, so round-trip the day instead.
const isRealDay = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};
function auditLogWhere(query) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const action = str(query.action);
  const target = str(query.target);
  const targetRef = str(query.targetRef);
  const user = str(query.user).trim();
  const from = str(query.from);
  const to = str(query.to);
  const legacy = query.legacy === 'true';
  for (const day of [from, to]) {
    if (day && (!AUDIT_DAY.test(day) || !isRealDay(day))) {
      return { error: 'Dates must be YYYY-MM-DD' };
    }
  }
  const dayAfter = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000);

  // Legacy role events predate stable refs and cannot always be attributed to
  // a specific role after a rename/name reuse. Keep them in a separate, clearly
  // labelled name-matched view rather than mixing them into ID-linked history.
  const filters = [
    action ? eq(auditLog.action, action) : undefined,
    target ? eq(auditLog.target, target) : undefined,
    targetRef ? eq(auditLog.target_ref, targetRef) : undefined,
    user ? eq(auditLog.username, user) : undefined,
    from ? gte(auditLog.created_at, new Date(`${from}T00:00:00Z`)) : undefined,
    to ? lt(auditLog.created_at, dayAfter(to)) : undefined,
    legacy ? and(sql`${auditLog.target_ref} IS NULL`, inArray(auditLog.action, ['admin_create_role', 'admin_update_role', 'admin_delete_role'])) : undefined,
  ].filter(Boolean);
  return { where: filters.length ? and(...filters) : undefined };
}

router.get('/audit-log', pAudit, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(Math.min(parseInt(req.query.limit, 10) || 50, 200), 1);
  const offset = (page - 1) * limit;
  const { where: whereClause, error } = auditLogWhere(req.query);
  if (error) return res.status(400).json({ error });
  const [{ total }] = await db.select({ total: count() }).from(auditLog).where(whereClause);
  const rows = await db.select().from(auditLog).where(whereClause)
    .orderBy(desc(auditLog.created_at)).limit(limit).offset(offset);
  res.json({ rows, total, page, limit });
});

// Every action actually recorded, for the filter dropdown (the code emits far
// more action names than any hand-kept list).
router.get('/audit-log/actions', pAudit, async (_req, res) => {
  const rows = await db.selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(asc(auditLog.action));
  res.json(rows.map((r) => r.action));
});

// shortcut: capped at AUDIT_EXPORT_MAX rows (newest first); page through with from/to if an export is truncated.
const AUDIT_EXPORT_MAX = 50_000;
router.get('/audit-log.csv', pAudit, async (req, res) => {
  const { where, error } = auditLogWhere(req.query);
  if (error) return res.status(400).json({ error });
  // One extra row tells a truncated export from one that exactly fills the cap.
  const fetched = await db.select().from(auditLog).where(where).orderBy(desc(auditLog.created_at)).limit(AUDIT_EXPORT_MAX + 1);
  const truncated = fetched.length > AUDIT_EXPORT_MAX;
  const rows = truncated ? fetched.slice(0, AUDIT_EXPORT_MAX) : fetched;
  const lines = [csvLine(['time', 'user', 'action', 'target', 'detail', 'ip', 'outcome', 'request_id'])];
  for (const r of rows) lines.push(csvLine([r.created_at, r.username, r.action, r.target, r.detail, r.ip, r.outcome, r.request_id]));
  await logAudit(req, 'admin_export_audit_log', '', `${rows.length} row(s)${truncated ? ' (truncated)' : ''}`);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="audit-log.csv"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }).send(`${lines.join('\r\n')}\r\n`);
});

export default router;
