import { Router, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { processKofiInbox, storeKofiWebhook } from '../services/kofi.ts';
import { PayPalError } from '../services/paypalClient.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';
import { log } from '../utils/logger.ts';

// Public Ko-fi ingress: POST /api/payments/kofi/webhook. Mounted before the
// JSON, session and CSRF middleware. Ko-fi posts a form with one `data` field
// holding JSON, and resends with the same message_id unless it gets a 200.
//
// Every response has an empty body, so nothing is revealed to a caller. The
// request body is never logged: it carries the verification token.

const perMinute = (value: string | undefined, fallback: number) => (Number(value) > 0 ? Number(value) : fallback);
const refuse = (status: number) => (_req: Request, res: Response) => { res.status(status).end(); };

// Flood protection. A 429 never loses a real event, because Ko-fi resends.
const clientLimiter = rateLimit({
  windowMs: 60_000,
  limit: perMinute(process.env.KOFI_WEBHOOK_RATE_LIMIT_PER_MINUTE, 60),
  standardHeaders: true,
  legacyHeaders: false,
  handler: refuse(429),
});
// Each request that parses costs a database read, so a distributed flood is
// also capped as a whole.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: perMinute(process.env.KOFI_WEBHOOK_GLOBAL_RATE_LIMIT_PER_MINUTE, 300),
  keyGenerator: () => 'kofi-webhook-global',
  standardHeaders: false,
  legacyHeaders: false,
  handler: refuse(429),
});

function requireHttps(req: Request, res: Response, next: NextFunction) {
  if (!req.secure) { res.status(403).end(); return; }
  next();
}

const router = Router();
router.post('/', clientLimiter, globalLimiter, requireHttps, urlencoded({ extended: false, limit: '64kb', parameterLimit: 20 }),
  async (req: Request, res: Response) => {
    try {
      // 200 is sent only after the event is durably stored (or was stored
      // before: a repeated message_id is acknowledged without a second row).
      await storeKofiWebhook(req.body?.data);
      res.status(200).end();
      void startBackgroundWork(() => processKofiInbox(), { kind: 'kofi-webhook-inbox' }).catch(() => {});
    } catch (err) {
      if (err instanceof PayPalError) { res.status(err.status).end(); return; }
      // Storage failed: no acknowledgement, so Ko-fi delivers again. Only the
      // database error code is logged; driver messages can quote parameters.
      const cause = err as { code?: string; cause?: { code?: string } } | null;
      log('error', 'kofi_webhook_storage_failed', { code: cause?.cause?.code ?? cause?.code ?? 'UNKNOWN' });
      res.status(500).end();
    }
  });
// Body-parser refusals (too large, undecodable) end here with an empty body.
router.use((err: { status?: number; type?: string } | null, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.status === 413 || err?.type === 'entity.too.large' ? 413 : 400).end();
});
export default router;
