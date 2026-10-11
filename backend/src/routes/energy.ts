import { Router } from 'express';
import { requireAdmin, requireAuth, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import {
  adminBudgetRecords, energyHistory, energyHosts, energyMonths, energyPreview, energySummary, householdShareMode,
  parseEnergyMonth, parseHistoryRange, parseHouseholdShareMode, parseMonthCount, setHouseholdShareMode,
  type HouseholdShareMode,
} from '../services/energyDashboard.ts';
import { energyAdminOverview } from '../services/energyAdminOverview.ts';
import { adminBudgetCsv, memberSummaryCsv } from '../services/energyExports.ts';
import { logAudit } from '../utils/audit.ts';
import { sanitizeError } from '../utils/sanitize.ts';

const router = Router();
// Financial and physical-status reads are deliberately browser-session only.
router.use(requireAuth, requireInteractiveSession);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });

function csv(res: any, filename: string, body: string) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff' }).send(body);
}

router.get('/summary', async (req, res) => {
  let month: string;
  try { month = parseEnergyMonth(req.query.month); } catch { return res.status(400).json({ error: 'Invalid month' }); }
  try { res.json(await energySummary(month)); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
// Member export: exactly the member summary DTO, flattened to field/value rows.
router.get('/summary.csv', async (req, res) => {
  let month: string;
  try { month = parseEnergyMonth(req.query.month); } catch { return res.status(400).json({ error: 'Invalid month' }); }
  try { csv(res, `energy-budget-${month}.csv`, memberSummaryCsv(await energySummary(month))); }
  catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.get('/history', async (req, res) => {
  let range: '24h' | '7d';
  try { range = parseHistoryRange(req.query.range); } catch { return res.status(400).json({ error: 'Invalid range' }); }
  try { res.json(await energyHistory(range)); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.get('/months', async (req, res) => {
  let count: number;
  try { count = parseMonthCount(req.query.count); } catch { return res.status(400).json({ error: 'Invalid count' }); }
  try { res.json(await energyMonths(count)); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.get('/hosts', async (_req, res) => {
  try { res.json(await energyHosts()); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.get('/preview', async (_req, res) => {
  try { res.json(await energyPreview()); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});

// Administrator view. Reads stored state only; the one setting it changes is
// the explicit household-total disclosure (default off).
router.get('/admin/overview', requireAdmin, async (_req, res) => {
  try { res.json(await energyAdminOverview()); } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.put('/admin/household-share', requireAdmin, requireRecentReauthentication, async (req, res) => {
  let mode: HouseholdShareMode;
  try { mode = parseHouseholdShareMode(req.body?.mode); } catch { return res.status(400).json({ error: 'INVALID_SHARE_MODE' }); }
  try {
    const previous = await householdShareMode();
    await setHouseholdShareMode(mode);
    await logAudit(req, 'energy.household_share.set', mode, `previous=${previous}`);
    res.json({ householdShare: mode });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
router.get('/admin/export.csv', requireAdmin, requireRecentReauthentication, async (req, res) => {
  let from: string; let to: string;
  try { to = parseEnergyMonth(req.query.to); from = parseEnergyMonth(req.query.from ?? to); }
  catch { return res.status(400).json({ error: 'Invalid month' }); }
  try {
    const body = adminBudgetCsv(await adminBudgetRecords(from, to));
    await logAudit(req, 'energy.budget.export', `${from}..${to}`);
    csv(res, `energy-budget-records-${from}-${to}.csv`, body);
  } catch (err) {
    if (err instanceof Error && err.message === 'INVALID_RANGE') return res.status(400).json({ error: 'Invalid month range' });
    res.status(500).json({ error: sanitizeError(err) });
  }
});

export default router;
