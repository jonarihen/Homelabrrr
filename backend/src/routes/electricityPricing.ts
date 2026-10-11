import { Router } from 'express';
import { and, eq, lt, gt, or, isNull, sql, desc, ne, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { electricityContracts, electricityTariffs, electricityBills, electricityCostStatements } from '../db/schema/index.ts';
import { requireAuth, requireAdmin, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { logAudit } from '../utils/audit.ts';
import { parseDkkPerKwh } from '../services/powerPolicy.ts';
import { calculateLabCost, getApplicablePrice, syncPublishedSpotPrices } from '../services/electricityPricing.ts';
import { previewMonthlyElectricity, finalizeMonthlyElectricity } from '../services/monthlyElectricity.ts';
import { startOfLocalDateUtc } from '../services/energyAccounting.ts';
import { createExtraLabLoad, listExtraLabLoads } from '../services/extraLabLoads.ts';

const router = Router();
router.use(requireAuth, requireAdmin, requireInteractiveSession);
const rate = (value: unknown) => { if (typeof value !== 'string') throw new Error('INVALID_RATE'); parseDkkPerKwh(value); return value; };
const instant = (value: unknown) => { const date = new Date(String(value)); if (!Number.isFinite(date.getTime())) throw new Error('INVALID_DATE'); return date; };
const fail = (res: any, err: unknown) => {
  const known = err instanceof Error && (/^(INVALID_|OVERLAPPING_|MISSING_|FINALIZED_|EXTRA_LOAD_LIMIT)/.test(err.message) || ['Cannot finalize an open month', 'Incomplete calculation cannot be finalized', 'Recalculation reason required', 'Invalid billing month', 'Invalid statement input', 'Month has not started', 'Calculation inputs changed; preview again', 'Contract not found'].includes(err.message));
  return res.status(known ? 400 : 500).json({ error: known ? (err as Error).message : 'INTERNAL' });
};

router.get('/extra-loads', async (_req, res) => {
  try { res.json(await listExtraLabLoads()); } catch (err) { fail(res, err); }
});
router.post('/extra-loads', requireRecentReauthentication, async (req, res) => {
  try {
    const created = await createExtraLabLoad(req.body);
    await logAudit(req, 'electricity_extra_load_created', String(created.id), `source=${created.source_key}; validity=${created.valid_from.toISOString()}..${created.valid_to.toISOString()}`);
    res.status(201).json(created);
  } catch (err) { fail(res, err); }
});

router.get('/contracts', async (_req, res) => { res.json(await db.select().from(electricityContracts).orderBy(electricityContracts.valid_from)); });
router.get('/contracts/:id/tariffs', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'INVALID_CONTRACT' });
  res.json(await db.select().from(electricityTariffs).where(eq(electricityTariffs.contract_id, id)).orderBy(electricityTariffs.valid_from).limit(500));
});
function parseContractBody(b: any) {
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
  const feePolicy = b.fixedFeeAllocation || 'none';
  if (!['none', 'manual_share', 'energy_proportion'].includes(feePolicy)) throw new Error('INVALID_FIXED_FEE_POLICY');
  const feeShare = feePolicy === 'manual_share' ? rate(b.fixedFeeManualShare) : null;
  if (feeShare && (parseDkkPerKwh(feeShare) < 0n || parseDkkPerKwh(feeShare) > 1_000_000n)) throw new Error('INVALID_FIXED_FEE_SHARE');
  return { label: b.label.trim(), kind: b.kind, area: b.area, valid_from: from, valid_to: to, fixed_dkk_per_kwh: fixed, spot_margin_dkk_per_kwh: margin, vat_rate: vat,
    required_components: b.kind === 'spot' ? b.requiredComponents : null, fixed_monthly_ore: monthly, fixed_fee_allocation: feePolicy, fixed_fee_manual_share: feeShare, provenance: b.provenance.trim() };
}
type ContractValues = ReturnType<typeof parseContractBody>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertContract(tx: Tx, values: ContractValues, active: boolean) {
  const overlapping = await tx.select({ id: electricityContracts.id }).from(electricityContracts).where(and(eq(electricityContracts.active, true), lt(electricityContracts.valid_from, values.valid_to || new Date('9999-12-31T00:00:00Z')), or(isNull(electricityContracts.valid_to), gt(electricityContracts.valid_to, values.valid_from)))).limit(1);
  if (active && overlapping.length) throw new Error('OVERLAPPING_CONTRACT');
  const [created] = await tx.insert(electricityContracts).values({ ...values, active }).returning();
  return created;
}

// Ending a contract never rewrites a finalized month: the new end must not cut
// into any period already covered by a finalized statement that used it.
async function endContract(tx: Tx, id: number, validTo: Date, reason: string) {
  const [row] = await tx.select().from(electricityContracts).where(and(eq(electricityContracts.id, id), eq(electricityContracts.active, true))).for('update').limit(1);
  if (!row) throw new Error('INVALID_CONTRACT_NOT_ACTIVE');
  if (validTo <= row.valid_from || (row.valid_to && validTo >= row.valid_to)) throw new Error('INVALID_CONTRACT_END');
  const statements = await tx.select({ contract_id: electricityCostStatements.contract_id, calculation: electricityCostStatements.calculation }).from(electricityCostStatements)
    .where(and(eq(electricityCostStatements.finalized, true), gt(electricityCostStatements.period_end, validTo), row.valid_to ? lt(electricityCostStatements.period_start, row.valid_to) : sql`true`)).limit(1000);
  if (statements.some((statement) => statement.contract_id === id || ((statement.calculation as { contractRefs?: unknown })?.contractRefs as string[] | undefined)?.includes(String(id)))) throw new Error('FINALIZED_PERIOD');
  const [ended] = await tx.update(electricityContracts).set({ valid_to: validTo, end_reason: reason, revision: sql`${electricityContracts.revision} + 1` })
    .where(eq(electricityContracts.id, id)).returning();
  return ended;
}
const endReason = (value: unknown) => { const reason = typeof value === 'string' ? value.trim() : ''; if (!reason || reason.length > 1000) throw new Error('INVALID_REASON'); return reason; };
const contractId = (value: unknown) => { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw new Error('INVALID_CONTRACT'); return id; };

router.post('/contracts', requireRecentReauthentication, async (req, res) => {
  try {
    const values = parseContractBody(req.body || {});
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237001)`);
      return insertContract(tx, values, req.body?.active === true);
    });
    await logAudit(req, 'electricity_contract_created', String(result.id), `kind=${result.kind}; area=${result.area}; active=${result.active}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
// End-date an active contract (e.g. the agreement terminated). History before
// the end keeps being priced under it; it is not withdrawn.
router.post('/contracts/:id/end', requireRecentReauthentication, async (req, res) => {
  try {
    const id = contractId(req.params.id); const validTo = instant(req.body?.validTo); const reason = endReason(req.body?.reason);
    const ended = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237001)`);
      return endContract(tx, id, validTo, reason);
    });
    await logAudit(req, 'electricity_contract_ended', String(id), `valid_to=${validTo.toISOString()}; reason=${reason}`);
    res.json(ended);
  } catch (err) { fail(res, err); }
});
// Atomically end the current contract and start its successor at the same
// instant, so there is neither a pricing gap nor an overlap.
router.post('/contracts/:id/supersede', requireRecentReauthentication, async (req, res) => {
  try {
    const id = contractId(req.params.id); const effectiveAt = instant(req.body?.effectiveAt); const reason = endReason(req.body?.reason);
    const values = parseContractBody({ ...(req.body?.successor || {}), validFrom: effectiveAt.toISOString() });
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237001)`);
      await endContract(tx, id, effectiveAt, reason);
      const successor = await insertContract(tx, values, true);
      const [previous] = await tx.update(electricityContracts).set({ superseded_by_id: successor.id }).where(eq(electricityContracts.id, id)).returning();
      return { previous, successor };
    });
    await logAudit(req, 'electricity_contract_superseded', String(id), `successor=${result.successor.id}; effective=${effectiveAt.toISOString()}; reason=${reason}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
router.post('/contracts/:id/deactivate', requireRecentReauthentication, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'INVALID_CONTRACT' });
  try {
    const [row] = await db.update(electricityContracts).set({ active: false, revision: sql`${electricityContracts.revision} + 1` })
      .where(and(eq(electricityContracts.id, id), eq(electricityContracts.active, true))).returning();
    if (!row) return res.status(404).json({ error: 'ACTIVE_CONTRACT_NOT_FOUND' });
    await logAudit(req, 'electricity_contract_deactivated', String(id));
    res.json(row);
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
router.post('/contracts/:id/tariffs/:tariffId/revise', requireRecentReauthentication, async (req, res) => {
  try {
    const contractId = Number(req.params.id); const tariffId = Number(req.params.tariffId);
    const from = instant(req.body?.effectiveFrom);
    const newRate = rate(req.body?.dkkPerKwh);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isSafeInteger(contractId) || contractId < 1 || !Number.isSafeInteger(tariffId) || tariffId < 1 || !reason || reason.length > 1000 || typeof req.body?.vatIncluded !== 'boolean') throw new Error('INVALID_TARIFF_REVISION');
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237002)`);
      const [old] = await tx.select().from(electricityTariffs).where(and(eq(electricityTariffs.id, tariffId), eq(electricityTariffs.contract_id, contractId))).for('update').limit(1);
      if (!old || from <= old.valid_from || from >= old.valid_to) throw new Error('INVALID_TARIFF_REVISION');
      const [finalized] = await tx.select({ id: electricityCostStatements.id }).from(electricityCostStatements)
        .where(and(eq(electricityCostStatements.contract_id, contractId), gt(electricityCostStatements.period_end, from), lt(electricityCostStatements.period_start, old.valid_to))).limit(1);
      if (finalized) throw new Error('FINALIZED_PERIOD');
      await tx.update(electricityTariffs).set({ valid_to: from }).where(eq(electricityTariffs.id, tariffId));
      const [next] = await tx.insert(electricityTariffs).values({ contract_id: contractId, component: old.component, valid_from: from, valid_to: old.valid_to,
        dkk_per_kwh: newRate, vat_included: req.body.vatIncluded, provenance: `revision: ${reason}`, revision: old.revision + 1 }).returning();
      return next;
    });
    await logAudit(req, 'electricity_tariff_revised', String(created.id), `contract=${contractId}; prior=${tariffId}; reason=${reason}`);
    res.status(201).json(created);
  } catch (err) { fail(res, err); }
});
router.get('/current', async (req, res) => {
  const ref = String(req.query.contractRef || '');
  const basis = req.query.basis === 'spot_only_excluding_retail_additions' ? req.query.basis : 'variable_retail_including_vat';
  res.json(await getApplicablePrice(new Date(), ref, basis));
});
router.post('/sync', async (req, res) => { try { const result = await syncPublishedSpotPrices(); await logAudit(req, 'electricity_spot_sync'); res.json(result); } catch (err) { fail(res, err); } });
function parseBillBody(b: any) {
  const contractId = Number(b.contractId); const from = instant(b.periodStart); const to = instant(b.periodEnd);
  const ore = Number(b.amountOre);
  if (!Number.isSafeInteger(contractId) || contractId < 1 || to <= from || !Number.isSafeInteger(ore) || ore < 0 || !['advance', 'settlement'].includes(b.kind)) throw new Error('INVALID_BILL');
  if (b.billedKwh != null && (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(String(b.billedKwh)) || String(b.billedKwh).length > 24)) throw new Error('INVALID_BILLED_KWH');
  return { contract_id: contractId, period_start: from, period_end: to, amount_ore: ore, billed_kwh: b.billedKwh == null ? null : String(b.billedKwh), kind: b.kind as string,
    reference: b.reference ? String(b.reference).slice(0, 256) : null, note: b.note ? String(b.note).slice(0, 2000) : null };
}
type BillValues = ReturnType<typeof parseBillBody>;
// Advance and settlement bills are tracked separately; within one kind a
// non-void bill may not overlap another, so an invoice cannot count twice.
async function assertNoOverlappingBill(tx: Tx, values: BillValues, ignoreId: number | null = null) {
  const overlap = await tx.select({ id: electricityBills.id }).from(electricityBills).where(and(eq(electricityBills.contract_id, values.contract_id), eq(electricityBills.kind, values.kind),
    ne(electricityBills.status, 'void'), lt(electricityBills.period_start, values.period_end), gt(electricityBills.period_end, values.period_start),
    ...(ignoreId ? [ne(electricityBills.id, ignoreId)] : []))).limit(1);
  if (overlap.length) throw new Error('OVERLAPPING_BILL');
}
router.post('/bills', requireRecentReauthentication, async (req, res) => {
  try {
    const values = parseBillBody(req.body || {});
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237003)`);
      await assertNoOverlappingBill(tx, values);
      const [created] = await tx.insert(electricityBills).values({ ...values, status: 'due' }).returning();
      return created;
    });
    await logAudit(req, 'electricity_bill_created', String(result.id), `contract=${result.contract_id}; kind=${result.kind}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
router.get('/bills', async (_req, res) => { res.json(await db.select().from(electricityBills).orderBy(electricityBills.period_start, electricityBills.revision).limit(240)); });
// paidOre is the cumulative amount actually paid so far; it may only grow.
// Less than the invoiced amount records a partial payment, never "paid".
router.post('/bills/:id/paid', requireRecentReauthentication, async (req, res) => {
  try {
    const id = Number(req.params.id); const paidOre = Number(req.body?.paidOre); const paidAt = instant(req.body?.paidAt);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(paidOre) || paidOre <= 0) throw new Error('INVALID_PAYMENT');
    const [due] = await db.select().from(electricityBills).where(and(eq(electricityBills.id, id), inArray(electricityBills.status, ['due', 'partially_paid']))).limit(1);
    if (!due) return res.status(409).json({ error: 'BILL_NOT_DUE' });
    if (paidOre <= (due.paid_ore ?? 0)) throw new Error('INVALID_PAYMENT');
    const status = paidOre >= due.amount_ore ? 'paid' : 'partially_paid';
    const [bill] = await db.update(electricityBills).set({ status, paid_at: paidAt, paid_ore: paidOre })
      .where(and(eq(electricityBills.id, id), eq(electricityBills.status, due.status), due.paid_ore == null ? isNull(electricityBills.paid_ore) : eq(electricityBills.paid_ore, due.paid_ore))).returning();
    if (!bill) return res.status(409).json({ error: 'BILL_NOT_DUE' });
    await logAudit(req, 'electricity_bill_paid', String(id), `paid_ore=${paidOre}; status=${status}`);
    res.json(bill);
  } catch (err) { fail(res, err); }
});
router.post('/bills/:id/void', requireRecentReauthentication, async (req, res) => {
  try {
    const id = Number(req.params.id); const reason = endReason(req.body?.reason);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('INVALID_BILL');
    const [bill] = await db.update(electricityBills).set({ status: 'void', voided_at: new Date(), void_reason: reason })
      .where(and(eq(electricityBills.id, id), ne(electricityBills.status, 'void'))).returning();
    if (!bill) return res.status(404).json({ error: 'BILL_NOT_FOUND' });
    await logAudit(req, 'electricity_bill_voided', String(id), `reason=${reason}`);
    res.json(bill);
  } catch (err) { fail(res, err); }
});
// Correct a bill: the old row is voided and a new revision appended; recorded
// payments carry over to the corrected invoice.
router.post('/bills/:id/revise', requireRecentReauthentication, async (req, res) => {
  try {
    const id = Number(req.params.id); const reason = endReason(req.body?.reason);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('INVALID_BILL');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(237003)`);
      const [old] = await tx.select().from(electricityBills).where(and(eq(electricityBills.id, id), ne(electricityBills.status, 'void'))).for('update').limit(1);
      if (!old) throw new Error('INVALID_BILL');
      const values = parseBillBody({ contractId: old.contract_id, kind: old.kind, ...req.body });
      await assertNoOverlappingBill(tx, values, id);
      await tx.update(electricityBills).set({ status: 'void', voided_at: new Date(), void_reason: `revised: ${reason}` }).where(eq(electricityBills.id, id));
      const paid = old.paid_ore ?? null;
      const [created] = await tx.insert(electricityBills).values({ ...values, revision: old.revision + 1, previous_id: old.id, paid_ore: paid, paid_at: old.paid_at,
        status: paid == null ? 'due' : paid >= values.amount_ore ? 'paid' : 'partially_paid' }).returning();
      return created;
    });
    await logAudit(req, 'electricity_bill_revised', String(result.id), `prior=${id}; revision=${result.revision}; reason=${reason}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
router.get('/cost', async (req, res) => { try { res.json(await calculateLabCost(instant(req.query.from), instant(req.query.to), String(req.query.contractRef || ''))); } catch (err) { fail(res, err); } });
router.get('/months/:month/preview', async (req, res) => {
  try { res.json(await previewMonthlyElectricity(String(req.params.month), String(req.query.contractRef || ''), new Date(), req.query.scenarioDkkPerKwh ? String(req.query.scenarioDkkPerKwh) : null)); }
  catch (err) { fail(res, err); }
});
router.get('/months/:month/statements', async (req, res) => {
  const contractId = Number(req.query.contractRef);
  if (!Number.isSafeInteger(contractId) || contractId < 1 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(req.params.month)) return res.status(400).json({ error: 'INVALID_PERIOD' });
  const start = startOfLocalDateUtc(`${req.params.month}-01`);
  res.json(await db.select().from(electricityCostStatements).where(and(eq(electricityCostStatements.contract_id, contractId), eq(electricityCostStatements.period_start, start))).orderBy(desc(electricityCostStatements.revision)).limit(120));
});
router.post('/months/:month/finalize', requireRecentReauthentication, async (req, res) => {
  try {
    if (typeof req.body?.reason !== 'string') return res.status(400).json({ error: 'INVALID_REASON' });
    if (req.body.acknowledgePartial !== undefined && typeof req.body.acknowledgePartial !== 'boolean') return res.status(400).json({ error: 'INVALID_ACKNOWLEDGEMENT' });
    const result = await finalizeMonthlyElectricity(String(req.params.month), String(req.body.contractRef || ''), req.body.reason, new Date(), { acknowledgePartial: req.body.acknowledgePartial === true });
    const partial = (result.calculation as { partialAcknowledged?: boolean }).partialAcknowledged === true;
    await logAudit(req, 'electricity_month_finalized', String(result.id), `contract=${result.contract_id}; month=${req.params.month}; revision=${result.revision}${partial ? '; partial_coverage_acknowledged' : ''}`);
    res.status(201).json(result);
  } catch (err) { fail(res, err); }
});
export default router;
