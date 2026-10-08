import { Router } from 'express';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { captureOneOff, createOneOff, createMonthly, cancelMonthly, ownPaymentHistory, paypalSetupStatus, savePaypalConfiguration, setPaypalEnabled, verifiedContributionSnapshot, reconcilePaypalManual } from '../services/paypal.ts';
import { PayPalError } from '../services/paypalClient.ts';
import { logAudit } from '../utils/audit.ts';

const router = Router();
router.use(requireAuth, requireInteractiveSession);
function fail(res: any, err: unknown) { res.status(err instanceof PayPalError ? err.status : 500).json({ error: err instanceof PayPalError ? err.code : 'INTERNAL' }); }
router.get('/mine', async (req, res) => { try { res.json({ items: await ownPaymentHistory(req.session.userId!) }); } catch (err) { fail(res, err); } });
router.post('/one-off', async (req, res) => {
  try { res.status(201).json(await createOneOff(req.session.userId!, req.body?.amount, req.body?.environment ?? 'sandbox')); }
  catch (err) { fail(res, err); }
});
router.post('/one-off/:intentId/capture', async (req, res) => {
  try { res.json(await captureOneOff(req.session.userId!, req.params.intentId)); }
  catch (err) { fail(res, err); }
});
router.post('/monthly', async (req, res) => {
  try { res.status(201).json(await createMonthly(req.session.userId!, req.body?.environment ?? 'sandbox')); } catch (err) { fail(res, err); }
});
router.post('/monthly/:id/cancel', async (req, res) => {
  try { res.json(await cancelMonthly(req.session.userId!, req.params.id)); } catch (err) { fail(res, err); }
});
router.get('/admin/summary', requireAdmin, async (_req, res) => { try { res.json(await verifiedContributionSnapshot('live')); } catch (err) { fail(res, err); } });
router.post('/admin/reconcile', requireAdmin, async (req, res) => { try { res.json(await reconcilePaypalManual(req.body?.environment ?? 'live')); } catch (err) { fail(res, err); } });
router.get('/admin/config', requireAdmin, async (_req, res) => { try { res.json(await paypalSetupStatus()); } catch (err) { fail(res, err); } });
router.post('/admin/config', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { await savePaypalConfiguration(req.body); await logAudit(req, 'paypal.config.save'); res.json(await paypalSetupStatus()); }
  catch (err) { fail(res, err); }
});
router.post('/admin/enabled', requireAdmin, requireRecentReauthentication, async (req, res) => {
  try { if (req.body?.environment === 'live' && req.body?.enabled === true && req.body?.confirmLive !== true) return res.status(400).json({ error: 'LIVE_CONFIRMATION_REQUIRED' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'INVALID_REQUEST' });
    await setPaypalEnabled(req.body.environment, req.body.enabled); await logAudit(req, 'paypal.checkout.toggle'); res.json(await paypalSetupStatus()); }
  catch (err) { fail(res, err); }
});
export default router;
