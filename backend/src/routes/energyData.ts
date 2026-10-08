import { Router } from 'express';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { logAudit } from '../utils/audit.ts';
import { energyDataStatus, saveRefreshToken, listAvailableMeters, selectMeter, disconnect, syncSelectedMeter } from '../services/eloverblik.ts';
import { ElOverblikError } from '../services/eloverblikClient.ts';

const router = Router();
router.use(requireAuth, requireAdmin, requireInteractiveSession);
function fail(res: any, err: unknown) {
  const code = err instanceof ElOverblikError ? err.code : 'INTERNAL';
  res.status(code === 'INTERNAL' ? 500 : code === 'METER_UNAUTHORIZED' ? 403 : code === 'NOT_CONFIGURED' ? 409 : 400).json({ error: code });
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
router.post('/sync', async (req, res) => {
  try {
    const result = await syncSelectedMeter();
    await logAudit(req, 'eloverblik.sync');
    res.json(result);
  } catch (err) { fail(res, err); }
});
router.post('/disconnect', requireRecentReauthentication, async (req, res) => {
  try { await disconnect(); await logAudit(req, 'eloverblik.connection.disconnect'); res.json(await energyDataStatus()); }
  catch (err) { fail(res, err); }
});
export default router;
