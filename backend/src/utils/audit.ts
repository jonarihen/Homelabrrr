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
}

// Low-level insert — used by request-scoped logAudit and by background jobs that
// have no `req` (e.g. the tag-sync scheduler).
export async function logAuditEntry({
  userId = null, username = 'system', action, target = '', detail = '', ip = '', requestId = '', outcome = 'success',
}: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    user_id: userId,
    username,
    action,
    target,
    detail,
    ip,
    request_id: requestId,
    outcome,
  });
}

export async function logAudit(req: any, action: string, target = '', detail = '', outcome = 'success'): Promise<void> {
  let username = req.session?.username || 'anonymous';
  // Attribute token-authenticated requests so scripted actions are traceable
  // to the specific personal API token that made them.
  if (req.apiToken?.name) {
    username = `${username} (token: ${req.apiToken.name})`;
  }
  await logAuditEntry({
    userId: req.session?.userId || null,
    username,
    action,
    target,
    detail,
    ip: req.ip || req.socket?.remoteAddress || '',
    requestId: req.requestId || '',
    outcome,
  });
}
