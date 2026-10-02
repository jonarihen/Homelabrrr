import { db } from '../db/client.ts';
import { auditLog } from '../db/schema/index.ts';

interface AuditEntry {
  userId?: number | null;
  username?: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
  requestId?: string;
  outcome?: string;
  targetRef?: string | null;
}

function auditRow({
  userId = null, username = 'system', action, target = '', detail = '', ip = '', requestId = '', outcome = 'success', targetRef = null,
}: AuditEntry) {
  return {
    user_id: userId,
    username,
    action,
    target,
    detail,
    ip,
    request_id: requestId,
    outcome,
    target_ref: targetRef,
  };
}

// Low-level insert — used by request-scoped logAudit and by background jobs that
// have no `req` (e.g. the tag-sync scheduler).
export async function logAuditEntry(entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values(auditRow(entry));
}

function requestEntry(req: any, action: string, target: string, detail: string, outcome: string, targetRef: string | null): AuditEntry {
  let username = req.session?.username || 'anonymous';
  // Attribute token-authenticated requests so scripted actions are traceable
  // to the specific personal API token that made them.
  if (req.apiToken?.name) {
    username = `${username} (token: ${req.apiToken.name})`;
  }
  return {
    userId: req.session?.userId || null,
    username,
    action,
    target,
    detail,
    ip: req.ip || req.socket?.remoteAddress || '',
    requestId: req.requestId || '',
    outcome,
    targetRef,
  };
}

// `targetRef` is an optional stable entity reference (e.g. `role:12`) that
// survives renames, unlike the human-readable `target`.
export async function logAudit(
  req: any, action: string, target = '', detail = '', outcome = 'success', targetRef: string | null = null,
): Promise<void> {
  await logAuditEntry(requestEntry(req, action, target, detail, outcome, targetRef));
}

// Writes request-scoped audit rows on a caller's transaction, so the audit
// trail commits or rolls back together with the change it describes.
export async function logAuditTx(
  tx: any, req: any, entries: Array<{ action: string; target?: string; detail?: string; targetRef?: string | null }>,
): Promise<void> {
  if (entries.length === 0) return;
  await tx.insert(auditLog).values(entries.map((e) => auditRow(
    requestEntry(req, e.action, e.target ?? '', e.detail ?? '', 'success', e.targetRef ?? null),
  )));
}
