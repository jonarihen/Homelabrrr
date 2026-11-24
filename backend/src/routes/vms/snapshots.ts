import { Router } from 'express';
import { getSnapshots, createSnapshot, deleteSnapshot, rollbackSnapshot } from '../../proxmox.ts';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { allowOp } from './shared.ts';

const router = Router();

// ─── VM Snapshots ───────────────────────────────────────────────────────────

router.get('/:node/:vmid/snapshots', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.snapshots.list'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    let snaps;
    try { snaps = await getSnapshots(node, vmid, 'qemu'); }
    catch { snaps = await getSnapshots(node, vmid, 'lxc'); }
    // Filter out 'current' pseudo-snapshot and sort by snaptime
    const filtered = (snaps || []).filter(s => s.name !== 'current');
    filtered.sort((a, b) => (b.snaptime || 0) - (a.snaptime || 0));
    res.json(filtered);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:node/:vmid/snapshots', async (req, res) => {
  const { node, vmid } = req.params;
  const { name, description, vmstate } = req.body;
  if (!(await allowOp(req, node, vmid, 'vm.snapshots.create'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!name) return res.status(400).json({ error: 'Snapshot name is required' });
  try {
    let upid;
    try { upid = await createSnapshot(node, vmid, 'qemu', name, description, vmstate); }
    catch { upid = await createSnapshot(node, vmid, 'lxc', name, description, false); }
    await logAudit(req, 'snapshot_create', `${node}/${vmid}`, name);
    res.json({ ok: true, upid });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:node/:vmid/snapshots/:snapname', async (req, res) => {
  const { node, vmid, snapname } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.snapshots.delete'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    try { await deleteSnapshot(node, vmid, 'qemu', snapname); }
    catch { await deleteSnapshot(node, vmid, 'lxc', snapname); }
    await logAudit(req, 'snapshot_delete', `${node}/${vmid}`, snapname);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Owner-only (issue #73): a rollback throws away the VM's current disks, which
// is exactly as destructive as a restore — neither see_all_vms nor
// can_operate_all_vms reaches it.
router.post('/:node/:vmid/snapshots/:snapname/rollback', async (req, res) => {
  const { node, vmid, snapname } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.snapshots.rollback'))) {
    return res.status(403).json({ error: 'You can only roll back snapshots on VMs assigned to you' });
  }
  try {
    try { await rollbackSnapshot(node, vmid, 'qemu', snapname); }
    catch { await rollbackSnapshot(node, vmid, 'lxc', snapname); }
    await logAudit(req, 'snapshot_rollback', `${node}/${vmid}`, snapname);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
