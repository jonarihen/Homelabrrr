import { Router, raw } from 'express';
import { storeVerifiedWebhook, processPaypalInbox } from '../services/paypal.ts';
import { PayPalError } from '../services/paypalClient.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';

const router = Router();
router.post('/:environment', raw({ type: 'application/json', limit: '128kb' }), async (req, res) => {
  if (!req.secure) return res.sendStatus(403);
  if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
  try {
    await storeVerifiedWebhook(req.params.environment, req.headers, req.body);
    res.sendStatus(204);
    void startBackgroundWork(() => processPaypalInbox(), { kind: 'paypal-webhook-inbox' }).catch(() => {});
  } catch (err) {
    res.sendStatus(err instanceof PayPalError ? err.status : 500);
  }
});
export default router;
