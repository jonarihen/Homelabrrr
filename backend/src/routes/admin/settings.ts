import { Router } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users, vmAssignments, vmLeases, settings } from '../../db/schema/index.ts';
import { setSetting } from '../../db/settings.ts';
import { getAllVMs } from '../../proxmox.ts';
import { requireAdmin } from '../../middleware/auth.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { nodeLookupCandidates } from '../../utils/nodeRef.ts';
import { getLeaseSettings, setLeaseSettings, computeLeaseView, updateLease, renewLease, runLeaseSweep, backfillLeases } from '../../utils/leases.ts';
import { getCapacitySettings, setCapacitySettings } from '../../utils/capacity.ts';
import { MEMORY_MODES } from '../../utils/capacityPolicy.ts';
import { serializeNodeIdentity } from './shared.ts';

const router = Router();

// ─── Settings ───────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, async (req, res) => {
  const rows = await db.select().from(settings);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  res.json(result);
});

router.put('/settings/:key', requireAdmin, async (req, res) => {
  const { value } = req.body;
  await setSetting(req.params.key, String(value));
  res.json({ ok: true });
});

// ─── Capacity policy (node memory pre-check) ────────────────────────────────
// How the provisioning pre-flight treats memory: off / warn (default) / block,
// compared against physical RAM × the overcommit ratio. Storage is not
// configurable — `storage.avail` is a real limit and always blocks.

router.get('/capacity-settings', requireAdmin, async (req, res) => {
  res.json({ ...(await getCapacitySettings()), memoryModes: MEMORY_MODES });
});

router.put('/capacity-settings', requireAdmin, async (req, res) => {
  const { memoryMode, overcommitRatio } = req.body || {};
  if (memoryMode !== undefined && memoryMode !== null && !MEMORY_MODES.includes(String(memoryMode))) {
    return res.status(400).json({ error: `Memory mode must be one of: ${MEMORY_MODES.join(', ')}` });
  }
  if (overcommitRatio !== undefined && overcommitRatio !== null) {
    const ratio = Number.parseFloat(overcommitRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return res.status(400).json({ error: 'Overcommit ratio must be a number greater than 0' });
    }
  }
  const capacity = await setCapacitySettings({ memoryMode, overcommitRatio });
  await logAudit(req, 'capacity_settings_update', '', `memory=${capacity.memoryMode} ratio=${capacity.overcommitRatio}`);
  res.json({ ...capacity, memoryModes: MEMORY_MODES });
});

// ─── VM Leases (expiry / reclaim) ────────────────────────────────────────────
// Admin-only: default lease duration + grace period, the full lease roster with
// live VM state and owner, exempt/adjust/extend/renew any lease, a reclaimable
// view, a manual sweep, and a backfill for pre-feature VMs.

router.get('/lease-settings', requireAdmin, async (req, res) => {
  res.json(await getLeaseSettings());
});

router.put('/lease-settings', requireAdmin, async (req, res) => {
  const { defaultDays, graceDays } = req.body || {};
  const leaseSettings = await setLeaseSettings({ defaultDays, graceDays });
  await logAudit(req, 'lease_settings_update', '', `default=${leaseSettings.defaultDays}d grace=${leaseSettings.graceDays}d`);
  res.json(leaseSettings);
});

router.get('/leases', requireAdmin, async (req, res) => {
  try {
    const leaseSettings = await getLeaseSettings();
    const graceDays = leaseSettings.graceDays;
    const rows = await db.select().from(vmLeases)
      .orderBy(sql`(${vmLeases.expires_at} IS NULL), ${vmLeases.expires_at} ASC`);

    // Live VM name/status/type + owner from assignments (best-effort — the
    // cluster may be briefly unreachable, in which case we still return leases).
    let vms = [];
    try { vms = await getAllVMs(); } catch { vms = []; }
    const vmByKey = new Map();
    for (const v of vms) {
      if (v.nodeRef) vmByKey.set(`${v.nodeRef}#${v.vmid}`, v);
      if (v.node) vmByKey.set(`${v.node}#${v.vmid}`, v);
    }

    const leases = await Promise.all(rows.map(async (row) => {
      const view = await computeLeaseView(row, graceDays);
      const identity = serializeNodeIdentity(row.node);
      const live = vmByKey.get(`${row.node}#${row.vmid}`)
        || vmByKey.get(`${identity.node}#${row.vmid}`)
        || null;
      const ownerCandidates = nodeLookupCandidates(row.node);
      const [owner] = ownerCandidates.length === 0 ? [] : await db.select({ username: users.username })
        .from(vmAssignments)
        .innerJoin(users, eq(users.id, vmAssignments.user_id))
        .where(and(eq(vmAssignments.vmid, row.vmid), inArray(vmAssignments.node, ownerCandidates)))
        .limit(1);

      return {
        ...view,
        node: identity.node,
        nodeRef: identity.nodeRef,
        vmid: row.vmid,
        name: live?.name || `VM ${row.vmid}`,
        type: live?.type || null,
        vmStatus: live?.status || 'unknown',
        owner: owner?.username || null,
        createdBy: row.created_by || '',
      };
    }));

    res.json({ settings: leaseSettings, leases });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.put('/leases/:node/:vmid', requireAdmin, async (req, res) => {
  const { node, vmid } = req.params;
  const { exempt, leaseDays, extendDays } = req.body || {};
  try {
    const lease = await updateLease(node, vmid, { exempt, leaseDays, extendDays, createdBy: req.session.username, actor: { userId: req.session.userId } });
    if (!lease) return res.status(400).json({ error: 'Could not update lease' });
    const detail = [
      exempt !== undefined ? `exempt=${exempt ? 1 : 0}` : null,
      leaseDays !== undefined && leaseDays !== null ? `leaseDays=${leaseDays}` : null,
      extendDays !== undefined && extendDays !== null ? `extendDays=${extendDays}` : null,
    ].filter(Boolean).join(' ');
    await logAudit(req, 'lease_adjust', `${node}/${vmid}`, detail);
    res.json({ ok: true, lease: await computeLeaseView(lease) });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/leases/:node/:vmid/renew', requireAdmin, async (req, res) => {
  const { node, vmid } = req.params;
  try {
    const lease = await renewLease(node, vmid, { createdBy: req.session.username, actor: { userId: req.session.userId } });
    if (!lease) return res.status(404).json({ error: 'This VM has no lease to renew' });
    await logAudit(req, 'lease_renew', `${node}/${vmid}`, `admin renewal #${lease.renewal_count}`);
    res.json({ ok: true, lease: await computeLeaseView(lease) });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/leases/sweep', requireAdmin, async (req, res) => {
  try {
    const result = await runLeaseSweep();
    await logAudit(req, 'lease_sweep', 'all', `checked=${result.checked} stopped=${result.stopped}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.post('/leases/backfill', requireAdmin, async (req, res) => {
  try {
    const created = await backfillLeases({ createdBy: req.session.username, actor: { userId: req.session.userId } });
    await logAudit(req, 'lease_backfill', 'all', `created=${created}`);
    res.json({ ok: true, created });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
