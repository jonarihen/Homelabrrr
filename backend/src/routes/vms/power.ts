import { Router } from 'express';
import { vmAction, lxcAction } from '../../proxmox.ts';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { allowOp } from './shared.ts';

const router = Router();

// ─── VM Actions ───────────────────────────────────────────────────────────────

router.post('/:node/:vmid/action', async (req, res) => {
  const { node, vmid } = req.params;
  const { action } = req.body;

  if (!(await allowOp(req, node, vmid, 'vm.power'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!['start', 'stop', 'reboot', 'shutdown'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    let upid;
    try {
      upid = await vmAction(node, vmid, action);
    } catch {
      upid = await lxcAction(node, vmid, action);
    }
    await logAudit(req, 'vm_action', `${node}/${vmid}`, action);
    res.json({ ok: true, upid });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
