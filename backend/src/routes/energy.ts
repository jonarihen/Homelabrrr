import { Router } from 'express';
import { requireAuth, requireInteractiveSession } from '../middleware/auth.ts';
import { energyHistory, energyHosts, energySummary, parseEnergyMonth, parseHistoryRange } from '../services/energyDashboard.ts';
import { sanitizeError } from '../utils/sanitize.ts';

const router = Router();
// Financial and physical-status reads are deliberately browser-session only.
router.use(requireAuth, requireInteractiveSession);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });

router.get('/summary', async (req, res) => {
  let month: string;
  try { month = parseEnergyMonth(req.query.month); } catch { return res.status(400).json({ error: 'Invalid month' }); }
  try { res.json(await energySummary(month)); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.get('/history', async (req, res) => {
  let range: '24h' | '7d';
  try { range = parseHistoryRange(req.query.range); } catch { return res.status(400).json({ error: 'Invalid range' }); }
  try { res.json(await energyHistory(range)); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.get('/hosts', async (_req, res) => {
  try { res.json(await energyHosts()); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

export default router;
