import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getVNCTicket, getLXCVNCTicket } from '../../proxmox.ts';
import { sendError } from '../../utils/httpError.ts';
import { allowOp } from './shared.ts';

const router = Router();

// Short-lived VNC session store (token → {node, vmid, ticket, port, expires})
export const vncSessions = new Map();

// ─── VNC ticket ───────────────────────────────────────────────────────────────

router.post('/:node/:vmid/vnc-ticket', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.vnc'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    let vncData;
    let vmtype = 'qemu';
    try {
      vncData = await getVNCTicket(node, vmid);
    } catch {
      vncData = await getLXCVNCTicket(node, vmid);
      vmtype = 'lxc';
    }
    const token = uuidv4();

    // Purge expired sessions
    for (const [k, v] of vncSessions) {
      if (v.expires < Date.now()) vncSessions.delete(k);
    }

    const now = Date.now();
    console.log(`[VNC-ticket] node=${node} vmid=${vmid} type=${vmtype} port=${vncData.port} issued`);

    vncSessions.set(token, {
      userId: req.session.userId,
      sessionId: req.sessionID,
      node, vmid, vmtype,
      ticket: vncData.ticket,
      port:   vncData.port,
      createdAt: now,
      expires: now + 120_000, // 2 min to establish connection
    });

    // Return ticket so noVNC can use it as VNC password
    res.json({ token, ticket: vncData.ticket });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
