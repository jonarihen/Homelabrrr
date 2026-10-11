import { Router } from 'express';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { logAudit } from '../utils/audit.ts';
import { energyDataStatus, saveRefreshToken, listAvailableMeters, selectMeter, disconnect, manualSyncSelectedMeter, parseManualPeriod } from '../services/eloverblik.ts';
import { ElOverblikError } from '../services/eloverblikClient.ts';

const router = Router();
router.use(requireAuth, requireAdmin, requireInteractiveSession);
const STATUS: Record<string, number> = { INTERNAL: 500, RATE_LIMIT: 429, RATE_LIMITED: 429, METER_UNAUTHORIZED: 403, NOT_CONFIGURED: 409,
  RECONNECT_REQUIRED: 409, METER_MISSING: 409, ATTENTION_REQUIRED: 409, NETWORK: 502, MALFORMED: 502, OVERSIZED: 502 };
function fail(res: any, err: unknown) {
  const code = err instanceof ElOverblikError ? err.code : 'INTERNAL';
  if ((code === 'RATE_LIMIT' || code === 'RATE_LIMITED') && err instanceof ElOverblikError && err.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
  res.status(STATUS[code] ?? (/^(HTTP_|UPSTREAM_)/.test(code) ? 502 : 400)).json({ error: code });
}
router.get('/status', async (_req, res) => { try { res.json(await energyDataStatus()); } catch (err) { fail(res, err); } });
router.get('/meters', async (_req, res) => { try { res.json({ meters: await listAvailableMeters() }); } catch (err) { fail(res, err); } });
router.post('/connection', requireRecentReauthentication, async (req, res) => {
  try {
    if (typeof req.body?.refreshToken !== 'string') return res.status(400).json({ error: 'INVALID_TOKEN' });
    await saveRefreshToken(req.body.refreshToken);
    await logAudit(req, 'eloverblik.connection.replace');
    res.json(await energyDataStatus());
  } catch (err) { fail(res, err); }
});
router.post('/meter', requireRecentReauthentication, async (req, res) => {
  try {
    await selectMeter(req.body?.meterId, req.body?.scope ?? 'household');
    await logAudit(req, 'eloverblik.meter.select');
    res.json(await energyDataStatus());
  } catch (err) { fail(res, err); }
});
// Rate-limited manual resync. With { from, to } (YYYY-MM-DD, at most 31 days)
// it re-imports that period without moving the backfill cursor.
router.post('/sync', async (req, res) => {
  try {
    const period = req.body?.from !== undefined || req.body?.to !== undefined ? parseManualPeriod(req.body?.from, req.body?.to) : null;
    const result = await manualSyncSelectedMeter(new Date(), period) as { status?: string; code?: string };
    await logAudit(req, 'eloverblik.sync', '', period ? `period=${req.body.from}..${req.body.to}` : '');
    if (result?.status === 'attention_required') return res.status(409).json({ error: result.code || 'ATTENTION_REQUIRED' });
    res.json(result);
  } catch (err) { fail(res, err); }
});
router.post('/disconnect', requireRecentReauthentication, async (req, res) => {
  try {
    if (req.body?.purgeHistory !== undefined && typeof req.body.purgeHistory !== 'boolean') return res.status(400).json({ error: 'INVALID_REQUEST' });
    const result = await disconnect({ purgeHistory: req.body?.purgeHistory === true });
    await logAudit(req, 'eloverblik.connection.disconnect', '', result.purged ? 'history purged' : 'history retained');
    res.json({ ...await energyDataStatus(), purged: result.purged });
  }
  catch (err) { fail(res, err); }
});
export default router;
