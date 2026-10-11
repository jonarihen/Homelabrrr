import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { captureOneOff, createOneOff, createMonthly, changeMonthly, addMonthlyPlan, deactivateMonthlyPlan, listMonthlyPlans, cancelMonthly, adminPaypalSubscriptions, adminCancelMonthly, ownPaymentHistory, memberPaypalStatus, paypalSetupStatus, savePaypalConfiguration, setPaypalEnabled, verifiedContributionSnapshot, reconcilePaypalManual, processPaypalInbox } from '../services/paypal.ts';
import { listPaypalReviewEvents, retryPaypalReviewEvent, dismissPaypalReviewEvent } from '../services/paypalReview.ts';
import { paypalLedgerCsv, paypalReconciliationHealth } from '../services/paypalOperations.ts';
import { paypalConfigHistoryList, provisionPaypalResource, testPaypalConnection } from '../services/paypalSetup.ts';
import { confirmManualContribution, listManualContributions, ownManualContributions, recordManualContribution, rejectManualContribution,
  reportManualContribution, reverseManualContribution } from '../services/manualContributions.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';
import { latestPaypalAllocation, recalculatePaypalAllocations } from '../services/paypalAllocation.ts';
import { PayPalError } from '../services/paypalClient.ts';
import { logAudit } from '../utils/audit.ts';

const router = Router();
router.use(requireAuth, requireInteractiveSession);
// Every payments read is private (own history, aggregate status, admin
// ledger): never cacheable by the browser or an intermediary.
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
// Per-member limits on provider-calling endpoints (checkout creation is also
// limited durably in the service). Keyed by the authenticated member.
const memberLimiter = (limit: number) => rateLimit({ windowMs: 10 * 60_000, limit, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `user:${req.session?.userId}`, handler: (_req, res) => { res.status(429).json({ error: 'RATE_LIMITED' }); } });
const checkoutLimiter = memberLimiter(10);
const captureLimiter = memberLimiter(30);
const cancelLimiter = memberLimiter(10);
const setupLimiter = memberLimiter(20);
function fail(res: any, err: unknown) { res.status(err instanceof PayPalError ? err.status : 500).json({ error: err instanceof PayPalError ? err.code : 'INTERNAL' }); }
router.get('/status', async (_req, res) => { try { res.json(await memberPaypalStatus()); } catch (err) { fail(res, err); } });
router.get('/mine', async (req, res) => {
  try { const [history, manualReports] = await Promise.all([ownPaymentHistory(req.session.userId!), ownManualContributions(req.session.userId!)]);
    res.json({ ...history, manualReports }); }
  catch (err) { fail(res, err); }
});
// A member's own bank-transfer report: evidence only, never posted until an
// administrator confirms it.
router.post('/manual-reports', cancelLimiter, async (req, res) => {
  try { res.status(201).json(await reportManualContribution(req.session.userId!, req.body)); } catch (err) { fail(res, err); }
});
router.post('/one-off', checkoutLimiter, async (req, res) => {
  try { res.status(201).json(await createOneOff(req.session.userId!, req.body?.amount, req.body?.environment ?? 'sandbox')); }
  catch (err) { fail(res, err); }
});
router.post('/one-off/:intentId/capture', captureLimiter, async (req, res) => {
  try { res.json(await captureOneOff(req.session.userId!, String(req.params.intentId))); }
  catch (err) { fail(res, err); }
});
router.post('/monthly', checkoutLimiter, async (req, res) => {
  try { res.status(201).json(await createMonthly(req.session.userId!, req.body?.environment ?? 'sandbox', req.body?.amount)); } catch (err) { fail(res, err); }
});
// Change = confirmed cancellation of the current subscription, then a new
// explicit PayPal approval for the new amount.
router.post('/monthly/:id/change', checkoutLimiter, async (req, res) => {
  try { res.json(await changeMonthly(req.session.userId!, String(req.params.id), req.body?.environment ?? 'sandbox', req.body?.amount)); }
  catch (err) { fail(res, err); }
});
router.post('/monthly/:id/cancel', cancelLimiter, async (req, res) => {
  try { res.json(await cancelMonthly(req.session.userId!, String(req.params.id))); } catch (err) { fail(res, err); }
});
router.get('/admin/summary', requireAdmin, async (_req, res) => { try { res.json(await verifiedContributionSnapshot('live')); } catch (err) { fail(res, err); } });
router.get('/admin/allocation', requireAdmin, async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'INVALID_MONTH' });
  try { res.json({ allocation: await latestPaypalAllocation(month) }); }
  catch (err) { fail(res, err); }
});
router.post('/admin/allocate', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const month = String(req.body?.month || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'INVALID_MONTH' });
    const result = await recalculatePaypalAllocations(month);
    await logAudit(req, 'paypal.month.allocate', String(req.body.month)); res.json(result); }
  catch (err) { fail(res, err); }
});
router.post('/admin/reconcile', requireAdmin, async (req, res) => { try { res.json(await reconcilePaypalManual(req.body?.environment ?? 'live')); } catch (err) { fail(res, err); } });
router.get('/admin/subscriptions', requireAdmin, async (req, res) => {
  try { res.json(await adminPaypalSubscriptions(req.query.environment ?? 'live', Number(req.query.offset ?? 0))); } catch (err) { fail(res, err); }
});
router.post('/admin/subscriptions/:id/cancel', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const result = await adminCancelMonthly(req.body?.environment, req.params.id);
    await logAudit(req, 'paypal.subscription.cancel', req.params.id); res.json(result); }
  catch (err) { fail(res, err); }
});
router.get('/admin/health', requireAdmin, async (req, res) => {
  try { res.json(await paypalReconciliationHealth(req.query.environment ?? 'live')); } catch (err) { fail(res, err); }
});
// Private ledger export; the download itself is audited (without amounts).
router.get('/admin/export.csv', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try {
    const environment = String(req.query.environment ?? 'live');
    const body = await paypalLedgerCsv(environment);
    await logAudit(req, 'paypal.ledger.export', environment);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="paypal-ledger-${environment}.csv"`,
      'X-Content-Type-Options': 'nosniff' }).send(body);
  } catch (err) { fail(res, err); }
});
const manualId = (value: unknown) => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw new PayPalError('INVALID_ID', 400); return id; };
router.get('/admin/manual', requireAdmin, async (req, res) => {
  try { res.json(await listManualContributions(req.query.status ?? 'reported', Number(req.query.offset ?? 0))); } catch (err) { fail(res, err); }
});
router.post('/admin/manual', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const result = await recordManualContribution(req.session.userId!, req.body);
    await logAudit(req, 'paypal.manual.record', `manual:${result.id}`); res.status(201).json(result); }
  catch (err) { fail(res, err); }
});
router.post('/admin/manual/:id/confirm', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const id = manualId(req.params.id); const result = await confirmManualContribution(req.session.userId!, id, req.body);
    await logAudit(req, 'paypal.manual.confirm', `manual:${id}`); res.json(result); }
  catch (err) { fail(res, err); }
});
router.post('/admin/manual/:id/reject', requireAdmin, async (req, res) => {
  try { const id = manualId(req.params.id); const result = await rejectManualContribution(req.session.userId!, id, req.body);
    await logAudit(req, 'paypal.manual.reject', `manual:${id}`); res.json(result); }
  catch (err) { fail(res, err); }
});
router.post('/admin/manual/:id/reverse', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const id = manualId(req.params.id); const result = await reverseManualContribution(req.session.userId!, id, req.body);
    await logAudit(req, 'paypal.manual.reverse', `manual:${id}`); res.json(result); }
  catch (err) { fail(res, err); }
});
router.get('/admin/monthly-plans', requireAdmin, async (req, res) => {
  try { res.json({ items: await listMonthlyPlans(req.query.environment ?? 'live') }); } catch (err) { fail(res, err); }
});
router.post('/admin/monthly-plans', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const items = await addMonthlyPlan(req.body?.environment, req.body?.planId, req.body?.amount);
    await logAudit(req, 'paypal.monthly_plan.add', String(req.body?.environment || '')); res.status(201).json({ items }); }
  catch (err) { fail(res, err); }
});
router.post('/admin/monthly-plans/:id/deactivate', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const items = await deactivateMonthlyPlan(req.body?.environment, manualId(req.params.id));
    await logAudit(req, 'paypal.monthly_plan.deactivate', `plan:${String(req.params.id)}`); res.json({ items }); }
  catch (err) { fail(res, err); }
});
router.get('/admin/review', requireAdmin, async (req, res) => {
  try { res.json(await listPaypalReviewEvents(req.query.environment ?? 'live', Number(req.query.offset ?? 0), req.query.status ?? 'needs_review')); }
  catch (err) { fail(res, err); }
});
router.post('/admin/review/:id/retry', requireAdmin, async (req, res) => {
  try { const result = await retryPaypalReviewEvent(String(req.body?.environment || ''), req.params.id, req.session.userId!);
    await logAudit(req, 'paypal.review.retry', String(req.params.id));
    void startBackgroundWork(() => processPaypalInbox(), { kind: 'paypal-webhook-inbox' }).catch(() => {});
    res.json(result); }
  catch (err) { fail(res, err); }
});
// The free-text note stays in the payments table; the audit entry carries
// only the event reference.
router.post('/admin/review/:id/dismiss', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { const result = await dismissPaypalReviewEvent(String(req.body?.environment || ''), req.params.id, req.session.userId!, req.body?.note);
    await logAudit(req, 'paypal.review.dismiss', String(req.params.id)); res.json(result); }
  catch (err) { fail(res, err); }
});
router.get('/admin/config', requireAdmin, async (_req, res) => { try { res.json(await paypalSetupStatus()); } catch (err) { fail(res, err); } });
router.get('/admin/config/history', requireAdmin, async (req, res) => {
  try { res.json({ items: await paypalConfigHistoryList(req.query.environment ?? 'live') }); } catch (err) { fail(res, err); }
});
// Saves are compare-and-set: the form must send the version it was based on
// (null for a first save), so a stale tab cannot overwrite newer settings.
router.post('/admin/config', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try {
    if (!req.body || !('expectedVersion' in req.body)) return res.status(400).json({ error: 'EXPECTED_VERSION_REQUIRED' });
    await savePaypalConfiguration(req.body, req.session.userId!); await logAudit(req, 'paypal.config.save', String(req.body.environment || ''));
    res.json(await paypalSetupStatus()); }
  catch (err) { fail(res, err); }
});
router.post('/admin/enabled', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { if (req.body?.environment === 'live' && req.body?.enabled === true && req.body?.confirmLive !== true) return res.status(400).json({ error: 'LIVE_CONFIRMATION_REQUIRED' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'INVALID_REQUEST' });
    const expected = Number.isInteger(req.body?.expectedVersion) ? req.body.expectedVersion : undefined;
    await setPaypalEnabled(req.body.environment, req.body.enabled, req.session.userId!, expected);
    await logAudit(req, 'paypal.checkout.toggle', `${String(req.body.environment || '')}:${req.body.enabled ? 'on' : 'off'}`); res.json(await paypalSetupStatus()); }
  catch (err) { fail(res, err); }
});
// Read-only: obtains a token and reads the webhook/plan back. Never charges.
router.post('/admin/test-connection', requireAdmin, setupLimiter, async (req, res) => {
  try { res.json(await testPaypalConnection(req.body?.environment)); } catch (err) { fail(res, err); }
});
// Explicit, idempotent provider setup (product, plan, webhook registration).
router.post('/admin/setup/:kind', requireAdmin, requireRecentReauthentication, setupLimiter, async (req, res) => {
  try { const result = await provisionPaypalResource(req.body?.environment, req.params.kind, { amount: req.body?.amount });
    await logAudit(req, 'paypal.setup.provision', `${String(req.body?.environment || '')}:${String(req.params.kind)}`); res.json(result); }
  catch (err) { fail(res, err); }
});
export default router;
