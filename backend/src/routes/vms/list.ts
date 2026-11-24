import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vmSchedules, pveHosts, vmAssignments, vmDetectedIps } from '../../db/schema/index.ts';
import { getVMStatus, getAllVMs, getLXCStatus } from '../../proxmox.ts';
import { sendError } from '../../utils/httpError.ts';
import { userSeesAllVms } from '../../utils/vmAccess.ts';
import { summarizeLease } from '../../utils/leases.ts';
import { decodeNodeRef, nodeLookupCandidates } from '../../utils/nodeRef.ts';
import { scheduleBadge } from '../../utils/schedule.ts';
import { allowOp, serializeNodeIdentity } from './shared.ts';

const router = Router();

// Overlay a lightweight power-schedule badge ({ stopTime, startTime, days, … })
// onto a VM listing so the dashboard can render "sleeps 23:00–08:00" without an
// extra round-trip per card. Matches on vmid + any node-ref candidate.
async function attachSchedules(list) {
  const rows = await db.select().from(vmSchedules).where(eq(vmSchedules.enabled, true));
  if (rows.length === 0) return list;
  const now = Date.now();
  return list.map((item) => {
    const candidates = new Set(nodeLookupCandidates(item.nodeRef || item.node));
    const row = rows.find((r) => (
      Number(r.vmid) === Number(item.vmid)
      && nodeLookupCandidates(r.node).some((c) => candidates.has(c))
    ));
    const badge = row ? scheduleBadge(row, now) : null;
    return badge ? { ...item, schedule: badge } : item;
  });
}

// Cached last-detected IP (written by GET .../detected-ips) so the dashboard
// card can show an address without upstream calls per VM.
async function attachDetectedIps(list) {
  const vmids = [...new Set(list.map((item) => Number(item.vmid)).filter(Number.isInteger))];
  if (vmids.length === 0) return list;
  const rows = await db.select().from(vmDetectedIps).where(inArray(vmDetectedIps.vmid, vmids));
  if (rows.length === 0) return list;
  return list.map((item) => {
    // Exact node-ref row first; a bare legacy alias only when no exact row exists.
    const ref = item.nodeRef || item.node;
    const candidates = new Set(nodeLookupCandidates(ref));
    const sameVm = rows.filter((r) => r.vmid === Number(item.vmid));
    const row = sameVm.find((r) => r.node === ref) || sameVm.find((r) => candidates.has(r.node));
    return row ? { ...item, detectedIp: row.ip } : item;
  });
}

// Display name of the PVE host a node ref belongs to — users get to SEE which
// host their VM runs on (moving it stays admin-only via /api/migrate).
async function hostNameForNode(nodeValue) {
  const { hostId } = decodeNodeRef(nodeValue);
  if (!hostId) return '';
  const [row] = await db.select({ name: pveHosts.name }).from(pveHosts).where(eq(pveHosts.id, hostId)).limit(1);
  return row?.name || '';
}

// ─── User's assigned VMs ──────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  if (await userSeesAllVms(req.session.userId, req.session.isAdmin)) {
    try {
      const vms = await getAllVMs();
      const withLease = await Promise.all(vms.map(async (vm) => {
        const identity = serializeNodeIdentity(vm.nodeRef || vm.node);
        return {
          ...vm,
          ...identity,
          lease: await summarizeLease(identity.nodeRef, vm.vmid),
        };
      }));
      return res.json(await attachDetectedIps(await attachSchedules(withLease)));
    } catch (err) {
      return sendError(res, err);
    }
  }

  const assignments = await db.select().from(vmAssignments).where(eq(vmAssignments.user_id, req.session.userId));

  const results = await Promise.all(assignments.map(async (a) => {
    const nodeIdentity = serializeNodeIdentity(a.node);
    const lease = await summarizeLease(a.node, a.vmid);
    const hostName = await hostNameForNode(a.node);
    try {
      const status = await getVMStatus(a.node, a.vmid);
      return { ...status, ...nodeIdentity, hostName, assignmentId: a.id, lease, type: 'qemu' };
    } catch {
      try {
        const status = await getLXCStatus(a.node, a.vmid);
        return { ...status, ...nodeIdentity, hostName, assignmentId: a.id, lease, type: 'lxc' };
      } catch {
        return { vmid: a.vmid, ...nodeIdentity, hostName, name: `VM ${a.vmid}`, status: 'error', assignmentId: a.id, lease };
      }
    }
  }));

  res.json(await attachDetectedIps(await attachSchedules(results)));
});

// ─── VM Status ────────────────────────────────────────────────────────────────

router.get('/:node/:vmid/status', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.status'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const nodeIdentity = serializeNodeIdentity(node);
    const lease = await summarizeLease(node, vmid);
    const hostName = await hostNameForNode(node);
    // Lets the UI hide Delete from users who can see but not own the VM.
    const canDelete = await allowOp(req, node, vmid, 'vm.delete');
    try {
      res.json({ ...(await getVMStatus(node, vmid)), ...nodeIdentity, hostName, vmid: parseInt(vmid, 10), type: 'qemu', lease, canDelete });
    } catch {
      res.json({ ...(await getLXCStatus(node, vmid)), ...nodeIdentity, hostName, vmid: parseInt(vmid, 10), type: 'lxc', lease, canDelete });
    }
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
