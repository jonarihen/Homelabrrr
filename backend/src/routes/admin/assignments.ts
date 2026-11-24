import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users, vmAssignments } from '../../db/schema/index.ts';
import { isUniqueViolation } from '../../db/errors.ts';
import { getAllVMs } from '../../proxmox.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { logAudit } from '../../utils/audit.ts';
import {
  syncVmTagsSafe,
  runFullTagSync,
  isTagSyncRunning,
  getTagSyncProgress,
  getTagSyncSettings,
  setTagSyncPaused,
  setTagSyncIntervalHours,
} from '../../utils/vmTags.ts';
import { pAssignments, serializeNodeIdentity } from './shared.ts';

const router = Router();

// ─── VMs (from Proxmox) ───────────────────────────────────────────────────────

router.get('/vms', pAssignments, async (req, res) => {
  try {
    const vms = await getAllVMs();
    const assignments = await db.select({
      id: vmAssignments.id, user_id: vmAssignments.user_id, node: vmAssignments.node, vmid: vmAssignments.vmid,
      username: users.username,
    }).from(vmAssignments).innerJoin(users, eq(users.id, vmAssignments.user_id));
    const rawVmCounts = new Map();
    vms.forEach(vm => {
      const key = `${vm.node}-${vm.vmid}`;
      rawVmCounts.set(key, (rawVmCounts.get(key) || 0) + 1);
    });

    const assignedMap = new Map(assignments.map(a => [`${a.node}-${a.vmid}`, a]));

    const enriched = vms.map(vm => {
      const exactKey = `${vm.nodeRef || vm.node}-${vm.vmid}`;
      const rawKey = `${vm.node}-${vm.vmid}`;
      const assignment = assignedMap.get(exactKey)
        || (rawVmCounts.get(rawKey) === 1 ? assignedMap.get(rawKey) : null)
        || null;
      return {
        ...vm,
        assignment,
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── VM Assignments ───────────────────────────────────────────────────────────

router.get('/assignments', pAssignments, async (req, res) => {
  const rows = await db.select({
    id: vmAssignments.id, user_id: vmAssignments.user_id, node: vmAssignments.node, vmid: vmAssignments.vmid,
    username: users.username,
  }).from(vmAssignments).innerJoin(users, eq(users.id, vmAssignments.user_id)).orderBy(users.username);
  res.json(rows.map(row => ({ ...row, ...serializeNodeIdentity(row.node) })));
});

router.post('/assignments', pAssignments, async (req, res) => {
  const { userId, node, vmid } = req.body;
  if (!userId || !node || !vmid) {
    return res.status(400).json({ error: 'userId, node and vmid required' });
  }
  try {
    const [r] = await db.insert(vmAssignments).values({ user_id: userId, node, vmid: parseInt(vmid) })
      .returning({ id: vmAssignments.id });
    await syncVmTagsSafe(node, vmid);
    res.json({ id: r.id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'VM already assigned to a user' });
    }
    throw err;
  }
});

router.delete('/assignments/:id', pAssignments, async (req, res) => {
  const [assignment] = await db.select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
    .from(vmAssignments).where(eq(vmAssignments.id, Number(req.params.id))).limit(1);
  await db.delete(vmAssignments).where(eq(vmAssignments.id, Number(req.params.id)));
  if (assignment) await syncVmTagsSafe(assignment.node, assignment.vmid);
  res.json({ ok: true });
});

// ─── PVE tag auto-sync (background scheduler + manual force-sync) ─────────────

// Snapshot of the auto-sync state for the Assignments status card: whether
// auto-sync is armed or paused (and by whom/when), the interval, whether a run
// is in flight right now (with live progress), and last-run stats/failures.
router.get('/tag-sync/status', pAssignments, async (req, res) => {
  try {
    const settings = await getTagSyncSettings();
    res.json({
      ...settings,
      running: isTagSyncRunning(),
      progress: getTagSyncProgress(),
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Pause the background scheduler. Persisted to `settings`, so it survives a
// backend restart; records who paused it and when for provenance.
router.post('/tag-sync/pause', pAssignments, async (req, res) => {
  try {
    await setTagSyncPaused(true, req.session?.username);
    await logAudit(req, 'vm_tags_sync_pause', 'all', 'auto-sync paused');
    res.json({ ...(await getTagSyncSettings()), running: isTagSyncRunning(), progress: getTagSyncProgress() });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Re-arm the background scheduler.
router.post('/tag-sync/resume', pAssignments, async (req, res) => {
  try {
    await setTagSyncPaused(false, req.session?.username);
    await logAudit(req, 'vm_tags_sync_resume', 'all', 'auto-sync resumed');
    res.json({ ...(await getTagSyncSettings()), running: isTagSyncRunning(), progress: getTagSyncProgress() });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Change the auto-sync interval (hours).
router.post('/tag-sync/interval', pAssignments, async (req, res) => {
  try {
    const hours = await setTagSyncIntervalHours(req.body?.intervalHours);
    await logAudit(req, 'vm_tags_sync_interval', 'all', `interval set to ${hours}h`);
    res.json({ ...(await getTagSyncSettings()), running: isTagSyncRunning(), progress: getTagSyncProgress() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Re-stamp owner/VLAN tags on every VM the portal can see — for the first
// rollout, or after NIC/VLAN changes made outside the portal. Shares the fleet
// loop with the background scheduler via runFullTagSync(). Only one run may be
// in flight at a time (409 if the scheduler or another operator is mid-run).
router.post('/sync-vm-tags', pAssignments, async (req, res) => {
  if (isTagSyncRunning()) {
    return res.status(409).json({ error: 'A tag sync is already running', running: true, progress: getTagSyncProgress() });
  }
  try {
    const summary = await runFullTagSync({ trigger: 'manual' });
    await logAudit(req, 'vm_tags_sync', 'all', `${summary.checked} checked, ${summary.updated} updated, ${summary.failed} failed`);
    res.json({ checked: summary.checked, updated: summary.updated, failed: summary.failed, failures: summary.failures });
  } catch (err) {
    if (err.code === 'TAG_SYNC_BUSY') {
      return res.status(409).json({ error: 'A tag sync is already running', running: true, progress: getTagSyncProgress() });
    }
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
