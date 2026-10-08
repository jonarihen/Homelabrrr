import { Router } from 'express';
import { and, eq, lt, gt, or, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityContracts, electricityTariffs, electricityBills } from '../db/schema/index.ts';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { logAudit } from '../utils/audit.ts';
import { parseDkkPerKwh } from '../services/powerPolicy.ts';
import { calculateLabCost, getApplicablePrice, syncPublishedSpotPrices } from '../services/electricityPricing.ts';

const router = Router();
router.use(requireAuth, requireAdmin, requireInteractiveSession);
const rate = (value: unknown) => { if (typeof value !== 'string') throw new Error('INVALID_RATE'); parseDkkPerKwh(value); return value; };
const instant = (value: unknown) => { const date = new Date(String(value)); if (!Number.isFinite(date.getTime())) throw new Error('INVALID_DATE'); return date; };
const fail = (res: any, err: unknown) => res.status(err instanceof Error && /^INVALID_|^OVERLAPPING_|^MISSING_/.test(err.message) ? 400 : 500).json({ error: err instanceof Error && /^INVALID_|^OVERLAPPING_|^MISSING_/.test(err.message) ? err.message : 'INTERNAL' });

router.get('/contracts', async (_req, res) => { res.json(await db.select().from(electricityContracts).orderBy(electricityContracts.valid_from)); });
router.get('/contracts/:id/tariffs', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'INVALID_CONTRACT' });
  res.json(await db.select().from(electricityTariffs).where(eq(electricityTariffs.contract_id, id)).orderBy(electricityTariffs.valid_from).limit(500));
});
router.post('/contracts', requireRecentReauthentication, async (req, res) => {
  try {
    const b = req.body || {};
    if (!['spot', 'fixed_all_in'].includes(b.kind) || !['DK1', 'DK2'].includes(b.area) || typeof b.label !== 'string' || !b.label.trim() || typeof b.provenance !== 'string' || !b.provenance.trim()) throw new Error('INVALID_CONTRACT');
    const from = instant(b.validFrom); const to = b.validTo ? instant(b.validTo) : null;
    if (to && to <= from) throw new Error('INVALID_CONTRACT');
    const fixed = b.kind === 'fixed_all_in' ? rate(b.fixedDkkPerKwh) : null;
    const margin = b.kind === 'spot' ? rate(b.spotMarginDkkPerKwh) : null;
    const vat = b.kind === 'spot' ? rate(b.vatRate) : null;
    if (vat && (parseDkkPerKwh(vat) < 0n || parseDkkPerKwh(vat) > 1_000_000n)) throw new Error('INVALID_VAT');
    if (b.kind === 'spot' && (!Array.isArray(b.requiredComponents) || b.requiredComponents.some((x: unknown) => !['network', 'system', 'tax', 'retailer'].includes(String(x))) || new Set(b.requiredComponents).size !== b.requiredComponents.length)) throw new Error('INVALID_COMPONENTS');
    const monthly = b.fixedMonthlyOre == null ? null : Number(b.fixedMonthlyOre);
    if (monthly != null && (!Number.isSafeInteger(monthly) || monthly < 0)) throw new Error('INVALID_FIXED_FEE');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237001)`);
      const overlapping = await tx.select({ id: electricityContracts.id }).from(electricityContracts).where(and(eq(electricityContracts.active, true), lt(electricityContracts.valid_from, to || new Date('9999-12-31T00:00:00Z')), or(isNull(electricityContracts.valid_to), gt(electricityContracts.valid_to, from)))).limit(1);
      if (b.active && overlapping.length) throw new Error('OVERLAPPING_CONTRACT');
      const [created] = await tx.insert(electricityContracts).values({ label: b.label.trim(), kind: b.kind, area: b.area, valid_from: from, valid_to: to, fixed_dkk_per_kwh: fixed, spot_margin_dkk_per_kwh: margin, vat_rate: vat, required_components: b.kind === 'spot' ? b.requiredComponents : null, fixed_monthly_ore: monthly, active: b.active === true, provenance: b.provenance.trim() }).returning();
      return created;
    });
    await logAudit(req, 'electricity_contract_created', String(result.id), `kind=${result.kind}; area=${result.area}; active=${result.active}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
router.post('/contracts/:id/tariffs', requireRecentReauthentication, async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    if (!Number.isSafeInteger(id) || id < 1 || !['network', 'system', 'tax', 'retailer'].includes(b.component) || typeof b.provenance !== 'string' || !b.provenance.trim()) throw new Error('INVALID_TARIFF');
    const from = instant(b.validFrom); const to = instant(b.validTo);
    if (to <= from || typeof b.vatIncluded !== 'boolean') throw new Error('INVALID_TARIFF');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237002)`);
      const [contract] = await tx.select({ id: electricityContracts.id }).from(electricityContracts).where(eq(electricityContracts.id, id)).limit(1);
      if (!contract) throw new Error('INVALID_CONTRACT');
      const overlap = await tx.select({ id: electricityTariffs.id }).from(electricityTariffs).where(and(eq(electricityTariffs.contract_id, id), eq(electricityTariffs.component, b.component), lt(electricityTariffs.valid_from, to), gt(electricityTariffs.valid_to, from))).limit(1);
      if (overlap.length) throw new Error('OVERLAPPING_TARIFF');
      const [created] = await tx.insert(electricityTariffs).values({ contract_id: id, component: b.component, valid_from: from, valid_to: to, dkk_per_kwh: rate(b.dkkPerKwh), vat_included: b.vatIncluded, provenance: b.provenance.trim() }).returning();
      return created;
    });
    await logAudit(req, 'electricity_tariff_created', String(result.id), `contract=${id}; component=${result.component}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
router.get('/current', async (req, res) => {
  const ref = String(req.query.contractRef || '');
  const basis = req.query.basis === 'spot_only_excluding_retail_additions' ? req.query.basis : 'variable_retail_including_vat';
  res.json(await getApplicablePrice(new Date(), ref, basis));
});
router.post('/sync', async (req, res) => { try { const result = await syncPublishedSpotPrices(); await logAudit(req, 'electricity_spot_sync'); res.json(result); } catch (err) { fail(res, err); } });
router.post('/bills', requireRecentReauthentication, async (req, res) => {
  try {
    const b = req.body || {}; const contractId = Number(b.contractId); const from = instant(b.periodStart); const to = instant(b.periodEnd);
    const ore = Number(b.amountOre);
    if (!Number.isSafeInteger(contractId) || contractId < 1 || to <= from || !Number.isSafeInteger(ore) || ore < 0 || !['advance', 'settlement'].includes(b.kind)) throw new Error('INVALID_BILL');
    if (b.billedKwh != null && (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(String(b.billedKwh)) || String(b.billedKwh).length > 24)) throw new Error('INVALID_BILLED_KWH');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237003)`);
      const overlap = await tx.select({ id: electricityBills.id }).from(electricityBills).where(and(eq(electricityBills.contract_id, contractId), eq(electricityBills.kind, b.kind), lt(electricityBills.period_start, to), gt(electricityBills.period_end, from))).limit(1);
      if (overlap.length) throw new Error('OVERLAPPING_BILL');
      const [created] = await tx.insert(electricityBills).values({ contract_id: contractId, period_start: from, period_end: to, amount_ore: ore, billed_kwh: b.billedKwh == null ? null : String(b.billedKwh), kind: b.kind, status: 'due', reference: b.reference ? String(b.reference).slice(0, 256) : null, note: b.note ? String(b.note).slice(0, 2000) : null }).returning();
      return created;
    });
    await logAudit(req, 'electricity_bill_created', String(result.id), `contract=${contractId}; kind=${result.kind}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
router.get('/bills', async (_req, res) => { res.json(await db.select().from(electricityBills).orderBy(electricityBills.period_start).limit(120)); });
router.post('/bills/:id/paid', requireRecentReauthentication, async (req, res) => {
  try {
    const id = Number(req.params.id); const paidOre = Number(req.body?.paidOre); const paidAt = instant(req.body?.paidAt);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(paidOre) || paidOre < 0) throw new Error('INVALID_PAYMENT');
    const [due] = await db.select({ amount_ore: electricityBills.amount_ore }).from(electricityBills).where(and(eq(electricityBills.id, id), eq(electricityBills.status, 'due'))).limit(1);
    if (!due || paidOre < due.amount_ore) throw new Error('INVALID_PAYMENT');
    const [bill] = await db.update(electricityBills).set({ status: 'paid', paid_at: paidAt, paid_ore: paidOre }).where(and(eq(electricityBills.id, id), eq(electricityBills.status, 'due'))).returning();
    if (!bill) return res.status(409).json({ error: 'BILL_NOT_DUE' });
    await logAudit(req, 'electricity_bill_paid', String(id), `amount_ore=${paidOre}`);
    res.json(bill);
  } catch (err) { fail(res, err); }
});
router.get('/cost', async (req, res) => { try { res.json(await calculateLabCost(instant(req.query.from), instant(req.query.to), String(req.query.contractRef || ''))); } catch (err) { fail(res, err); } });
export default router;
