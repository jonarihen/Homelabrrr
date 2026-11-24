import { Router } from 'express';
import { getVMRRD } from '../../proxmox.ts';
import { sendError } from '../../utils/httpError.ts';
import { allowOp } from './shared.ts';

const router = Router();

// ─── VM RRD data ──────────────────────────────────────────────────────────────

router.get('/:node/:vmid/rrddata', async (req, res) => {
  const { node, vmid } = req.params;
  const { timeframe = 'hour' } = req.query;
  if (!(await allowOp(req, node, vmid, 'vm.rrd'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // Try qemu first, fall back to lxc
    let data;
    try {
      data = await getVMRRD(node, vmid, 'qemu', timeframe);
    } catch {
      data = await getVMRRD(node, vmid, 'lxc', timeframe);
    }
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
