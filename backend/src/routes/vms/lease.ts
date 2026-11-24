import { Router } from 'express';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { summarizeLease, renewLease } from '../../utils/leases.ts';
import { allowOp } from './shared.ts';

const router = Router();

// ─── VM Lease renewal ─────────────────────────────────────────────────────────
// Strict ownership (like deletion) — an assignment, not see_all_vms, is
// required. Renewing resets the clock and bumps the renewal count.
router.post('/:node/:vmid/lease/renew', async (req, res) => {
  const { node, vmid } = req.params;

  if (!(await allowOp(req, node, vmid, 'vm.lease.renew'))) {
    return res.status(403).json({ error: 'You can only renew leases for VMs assigned to you' });
  }

  try {
    const lease = await renewLease(node, vmid, { createdBy: req.session.username, actor: { userId: req.session.userId } });
    if (!lease) return res.status(404).json({ error: 'This VM has no lease to renew' });
    await logAudit(req, 'lease_renew', `${node}/${vmid}`, `renewal #${lease.renewal_count}`);
    res.json({ ok: true, lease: await summarizeLease(node, vmid) });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
