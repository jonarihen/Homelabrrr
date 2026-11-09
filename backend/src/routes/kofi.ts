import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireRecentReauthentication } from '../middleware/auth.ts';
import { processKofiInbox, saveKofiConfiguration, setKofiEnabled } from '../services/kofi.ts';
import { addKofiMemberEmail, dismissKofiReviewEvent, kofiAdminStatus, linkKofiReviewEvent, listKofiMemberEmails, listKofiReceipts,
  listKofiReviewEvents, removeKofiMemberEmail, resolveKofiReceiptFee, retryKofiReviewEvent, reverseKofiReceipt,
  settleKofiReviewEvent } from '../services/kofiAdmin.ts';
import { PayPalError } from '../services/paypalClient.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';
import { logAudit } from '../utils/audit.ts';
import { log } from '../utils/logger.ts';

// Ko-fi administration, mounted at /api/payments/admin/kofi behind the
// payments router's session checks and requireAdmin. Routes that post money,
// dismiss an event or change the configuration also need a recent
// reauthentication. Audit entries carry ids only: never the token, an email
// or note text.

const router = Router();

// Known refusals answer with their code. Anything else is a fixed INTERNAL so
// no driver or upstream text can reach the browser; the log line carries only
// the database error code, because driver messages can quote parameters.
function fail(req: Request, res: Response, err: unknown) {
  if (err instanceof PayPalError) { res.status(err.status).json({ error: err.code }); return; }
  const cause = err as { code?: string; cause?: { code?: string } } | null;
  log('error', 'kofi_admin_request_failed', { requestId: req.requestId, code: cause?.cause?.code ?? cause?.code ?? 'UNKNOWN' });
  res.status(500).json({ error: 'INTERNAL' });
}
const offset = (req: Request) => Number(req.query.offset ?? 0);
const actor = (req: Request) => req.session.userId!;
const kick = () => { void startBackgroundWork(() => processKofiInbox(), { kind: 'kofi-webhook-inbox' }).catch(() => {}); };

router.get('/config', async (req, res) => { try { res.json(await kofiAdminStatus()); } catch (err) { fail(req, res, err); } });
router.post('/config', requireRecentReauthentication, async (req, res) => {
  try {
    const saved = await saveKofiConfiguration(req.body, actor(req));
    await logAudit(req, 'kofi.config.save', saved.tokenReplaced ? 'token_replaced' : 'page_url');
    res.json(await kofiAdminStatus());
  } catch (err) { fail(req, res, err); }
});
router.post('/enabled', requireRecentReauthentication, async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'INVALID_REQUEST' }); return; }
    await setKofiEnabled(req.body.enabled, actor(req));
    await logAudit(req, 'kofi.toggle', req.body.enabled ? 'on' : 'off');
    res.json(await kofiAdminStatus());
  } catch (err) { fail(req, res, err); }
});

router.get('/review', async (req, res) => {
  try { res.json(await listKofiReviewEvents(req.query.status ?? 'needs_review', offset(req))); } catch (err) { fail(req, res, err); }
});
router.post('/review/:id/link', async (req, res) => {
  try {
    const result = await linkKofiReviewEvent(req.params.id, req.body, actor(req));
    await logAudit(req, 'kofi.review.link', String(req.params.id), `receipt:${result.receiptId}`);
    res.json(result);
  } catch (err) { fail(req, res, err); }
});
// Records a payment made in another currency at the DKK amount received.
router.post('/review/:id/settle', requireRecentReauthentication, async (req, res) => {
  try {
    const result = await settleKofiReviewEvent(req.params.id, req.body, actor(req));
    await logAudit(req, 'kofi.review.settle', String(req.params.id), `receipt:${result.receiptId}`);
    res.json(result);
  } catch (err) { fail(req, res, err); }
});
router.post('/review/:id/retry', async (req, res) => {
  try {
    const result = await retryKofiReviewEvent(req.params.id, actor(req));
    await logAudit(req, 'kofi.review.retry', String(req.params.id));
    kick();
    res.json(result);
  } catch (err) { fail(req, res, err); }
});
// The note stays in the payments table; the audit entry carries only the event reference.
router.post('/review/:id/dismiss', requireRecentReauthentication, async (req, res) => {
  try {
    const result = await dismissKofiReviewEvent(req.params.id, actor(req), req.body?.note);
    await logAudit(req, 'kofi.review.dismiss', String(req.params.id));
    res.json(result);
  } catch (err) { fail(req, res, err); }
});

router.get('/receipts', async (req, res) => {
  try { res.json(await listKofiReceipts(req.query.status ?? 'net_unresolved', offset(req))); } catch (err) { fail(req, res, err); }
});
router.post('/receipts/:id/fee', requireRecentReauthentication, async (req, res) => {
  try {
    const result = await resolveKofiReceiptFee(req.params.id, req.body);
    await logAudit(req, 'kofi.receipt.fee', `receipt:${result.id}`);
    res.json(result);
  } catch (err) { fail(req, res, err); }
});
router.post('/receipts/:id/reverse', requireRecentReauthentication, async (req, res) => {
  try {
    const result = await reverseKofiReceipt(req.params.id, req.body);
    await logAudit(req, 'kofi.receipt.reverse', `receipt:${result.id}`, result.status);
    res.json(result);
  } catch (err) { fail(req, res, err); }
});

router.get('/members', async (req, res) => { try { res.json(await listKofiMemberEmails()); } catch (err) { fail(req, res, err); } });
router.post('/members', async (req, res) => {
  try {
    const result = await addKofiMemberEmail(req.body, actor(req));
    await logAudit(req, 'kofi.member_email.add', `member_email:${result.id}`, `user:${result.userId}`);
    res.status(201).json(result);
  } catch (err) { fail(req, res, err); }
});
router.delete('/members/:id', async (req, res) => {
  try {
    const result = await removeKofiMemberEmail(req.params.id);
    await logAudit(req, 'kofi.member_email.remove', `member_email:${String(req.params.id)}`);
    res.json(result);
  } catch (err) { fail(req, res, err); }
});

export default router;
