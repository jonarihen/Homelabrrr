import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { provisionedVms } from '../../db/schema/index.ts';
import { withFreshVmid, createVM } from '../../proxmox.ts';
import { requirePermission } from '../../middleware/auth.ts';
import { sendError, hasHttpStatus, tagStatus } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { log } from '../../utils/logger.ts';
import { recordBackgroundProvisionFailure } from '../../services/provisionFailure.ts';
import { notifyDeployment } from '../../services/deploymentNotification.ts';
import { checkVlanAssignment } from '../../utils/vlanAccess.ts';
import { assertStorageExposed } from '../../utils/storageVisibility.ts';
import { computeCpuTopology } from '../../utils/cpuTopology.ts';
import { assertNodeCapacity } from '../../utils/capacity.ts';
import { assertNodeAvailable } from '../../utils/nodeMaintenance.ts';
import { assertUserQuota } from '../../utils/quota.ts';
import { syncVmTagsSafe } from '../../utils/vmTags.ts';
import { toPveVmName } from '../../utils/vmName.ts';
import { startBackgroundWork } from '../../services/backgroundWork.ts';
import { submitProvision, recordProvisionOwnership } from '../../services/provisionOwnership.ts';
import { serializeNodeIdentity, stepList, setStep } from './shared.ts';
import { releaseCapacityAfter, pollTaskCompletion } from './tasks.ts';

const router = Router();

// ─── Full VM creation from scratch / ISO (admin OR can_create_vms) ───────────
//
// Gated on can_create_vms so permission-holders can build a VM from an
// available ISO. Non-admin callers are constrained exactly like /from-image:
// the network bridge is pinned to the default (vmbr0) so they can't inject a
// `bridge=...,tag=N` NIC onto a VLAN they lack access to, assignTo is ignored
// (the VM is self-assigned to the creator), and owner/VLAN PVE tags are stamped
// as usual. Node capacity + per-user quota (#18) and storage exposure (#19)
// already run below.

router.post('/create', requirePermission('can_create_vms'), async (req: any, res: any) => {
  const isAdmin = !!req.session.isAdmin;
  const {
    node, name, cores = 2, memoryGb = 2,
    diskSize = '20G', storage = 'local-lvm',
    iso, ostype = 'l26',
    bios = 'seabios', scsihw = 'virtio-scsi-single',
    description = '',
    assignTo, vlanTag,
  } = req.body;

  if (!node || !name) {
    return res.status(400).json({ error: 'Node and name are required' });
  }

  // PVE VM names must be DNS-like — sanitize before reserving a VMID or running
  // the capacity/quota checks, so a bad name fails fast instead of coming back
  // as a raw upstream 400 from createVM (utils/vmName.js). The identifier
  // pattern below is the wrong shape for a VM name: it permits "_" and leading
  // or trailing dots, which Proxmox rejects, and caps nothing.
  const vmName = toPveVmName(name);
  if (!vmName) {
    return res.status(400).json({ error: 'Name must contain letters or digits' });
  }

  // Parsed once so capacity, quota and the PVE size all agree ("1.5G" used to become 15 GB).
  const diskMatch = /^([1-9]\d*)G?$/i.exec(String(diskSize));
  if (!diskMatch) return res.status(400).json({ error: 'Disk size must be a positive whole number of GB' });
  const diskGb = Number(diskMatch[1]);

  // Non-admins can't pick a bridge (the networks list is admin-only) — pin them
  // to vmbr0. This also blocks a `bridge=vmbr0,tag=N` injection that would put
  // the NIC on a VLAN the user has no access to, bypassing the VLAN check below.
  const bridge = isAdmin ? String(req.body.bridge || 'vmbr0') : 'vmbr0';

  // These land in PVE property strings — same strict identifier rule as
  // /from-image and /clone. (`name` is not one of them: it is a DNS label, not
  // an identifier, and is validated by toPveVmName above.)
  for (const [field, value] of Object.entries({ storage, bridge, ostype, bios, scsihw })) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(value)) {
      return res.status(400).json({ error: `Invalid ${field}` });
    }
  }
  // Only an ISO volume ("<storage>:iso/<file>"); no other volume type and no
  // extra property-string options.
  const isoMatch = typeof iso === 'string' ? /^([a-zA-Z0-9._-]+):iso\/[^,]+$/.exec(iso) : null;
  if (iso && !isoMatch) {
    return res.status(400).json({ error: 'Invalid iso' });
  }

  // Authorize the target VLAN (same guard as /from-image and /clone). Non-admins
  // must place the VM on an assigned VLAN; the untagged/native network is
  // admin-only (utils/vlanAccess.js).
  const vlanErr = await checkVlanAssignment(db, { userId: req.session.userId, isAdmin, vlanTag });
  if (vlanErr) return res.status(vlanErr.status).json({ error: vlanErr.error });

  // Enforce storage exposure — never trust the dropdown. Non-admin
  // can_create_vms holders can't build onto a pool an admin has hidden,
  // even by naming it directly.
  try {
    await assertStorageExposed(node, storage, { isAdmin });
    if (isoMatch) await assertStorageExposed(node, isoMatch[1], { isAdmin });
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  // Held from the capacity check until the deploy job ends (#284).
  let releaseCapacity = () => {};
  try {
    // Refuse deployment to a node the admin has drained for maintenance
    await assertNodeAvailable(node);

    const cpuLayout = await computeCpuTopology(node, cores);

    // Refuse requests the node can't fit. Storage is a hard limit; memory is
    // advisory by default and comes back as a note on the deployment.
    const capacity = await assertNodeCapacity(node, {
      memoryMb: Math.round(parseFloat(memoryGb) * 1024),
      diskGb,
      storage,
      reserve: true,
    });
    releaseCapacity = capacity.release;
    const capacityNote = capacity.memoryWarning;
    // Per-user resource quota (skips admins / users without quotas). Now that
    // the route is open to can_create_vms holders, this rail actually bounds
    // non-admin from-scratch builds.
    await assertUserQuota(req.session.userId, {
      addCores: cpuLayout.totalVcpus,
      addMemoryMb: Math.round(parseFloat(memoryGb) * 1024),
      addDiskGb: diskGb,
    });

    const config = {
      name: vmName,
      cpu: 'host',
      sockets: cpuLayout.sockets,
      cores: cpuLayout.cores,
      memory: Math.round(parseFloat(memoryGb) * 1024),
      ostype,
      bios,
      scsihw,
      scsi0: `${storage}:${diskGb}`,
      net0: vlanTag ? `virtio,bridge=${bridge},tag=${parseInt(vlanTag)}` : `virtio,bridge=${bridge}`,
      ...(iso && { ide2: `${iso},media=cdrom` }),
      ...(description && { description }),
    };

    // Allocate the VMID last, after the capacity/quota rails have passed, and
    // hold it only for the create call itself (see /clone above).
    const targetUser = isAdmin ? (assignTo ? Number(assignTo) : null) : req.session.userId;

    // Track
    const steps = stepList([
      { key: 'reserve', label: 'Reserving VMID', status: 'done' },
      { key: 'capacity', label: 'Checking node capacity', status: 'done', note: capacityNote },
      { key: 'create', label: 'Creating VM', status: 'active' },
      { key: 'tags', label: 'Applying owner / VLAN tags', status: 'pending' },
    ]);
    const { provisionId, vmid, upid } = await submitProvision({
      user_id: req.session.userId, node, vmid: 0, name: vmName,
      source_type: 'create', steps, status: 'creating', request_id: req.requestId || '',
    }, {
      userId: targetUser, createdBy: req.session.username,
      cores: cpuLayout.sockets * cpuLayout.cores,
      memoryMb: config.memory, diskGb,
    }, (onReserved, marker) => withFreshVmid((id: number) => createVM(node, id, {
      ...config, description: `${description}\n${marker}`,
    }), { onReserved }));

    // Poll for completion, then stamp PVE owner/VLAN tags on the new VM
    if (upid) {
      startBackgroundWork(() => pollTaskCompletion(provisionId, node, upid)
        .then(async (ok) => {
          await setStep(provisionId, 'create', ok ? 'done' : 'error');
          if (!ok) return;
          await recordProvisionOwnership(provisionId);
          await setStep(provisionId, 'tags', 'active');
          await syncVmTagsSafe(node, vmid);
          await setStep(provisionId, 'tags', 'done');
          await db.update(provisionedVms).set({ status: 'ready', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
          await notifyDeployment(provisionId);
        }), { kind: 'provision', id: provisionId, requestId: req.requestId })
        .catch((err: any) => recordBackgroundProvisionFailure(provisionId, vmid, 'provision_create_background_failed', err))
        .finally(() => releaseCapacityAfter(node, upid, releaseCapacity));
    } else {
      // No task to wait on: the VM already exists in Proxmox.
      releaseCapacity();
      await setStep(provisionId, 'create', 'done');
      await recordProvisionOwnership(provisionId);
      await setStep(provisionId, 'tags', 'active');
      await db.update(provisionedVms).set({ status: 'ready', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
      startBackgroundWork(
        () => syncVmTagsSafe(node, vmid).finally(() => setStep(provisionId, 'tags', 'done')),
        { kind: 'tag-sync', id: provisionId, requestId: req.requestId },
      ).catch((err: any) => log('warn', 'provision_tag_sync_failed', { provisionId, vmid, error: err }));
      await notifyDeployment(provisionId);
    }

    await logAudit(req, 'vm_create', `${node}/${vmid}`, vmName);
    res.json({ id: provisionId, vmid, ...serializeNodeIdentity(node), status: 'creating', upid });
  } catch (err: any) {
    releaseCapacity();
    // An unreachable host makes VMID allocation unsafe rather than broken —
    // report it as "try again later" instead of a flat 500.
    if (!hasHttpStatus(err) && err.message?.includes('globally unique VMID')) tagStatus(err, 503);
    sendError(res, err);
  }
});

export default router;
