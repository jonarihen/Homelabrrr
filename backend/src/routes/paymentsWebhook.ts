import { Router, raw } from 'express';
import rateLimit from 'express-rate-limit';
import { storeVerifiedWebhook, processPaypalInbox } from '../services/paypal.ts';
import { PayPalError } from '../services/paypalClient.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';

const router = Router();
// Ingress flood protection. PayPal retries non-2xx deliveries, so a 429 never
// loses a legitimate event; the response body reveals nothing.
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.PAYPAL_WEBHOOK_RATE_LIMIT_PER_MINUTE) > 0 ? Number(process.env.PAYPAL_WEBHOOK_RATE_LIMIT_PER_MINUTE) : 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => { res.sendStatus(429); },
});
router.post('/:environment', webhookLimiter, raw({ type: 'application/json', limit: '128kb' }), async (req, res) => {
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
