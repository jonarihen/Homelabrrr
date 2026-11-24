import { Router } from 'express';
import { and, eq, ne, notLike } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { cloudImages } from '../../db/schema/index.ts';
import { withFreshVmid, createVM, getStorages, getAllVMs } from '../../proxmox.ts';
import { sendError, hasHttpStatus, tagStatus } from '../../utils/httpError.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { logAudit } from '../../utils/audit.ts';
import { log } from '../../utils/logger.ts';
import { recordBackgroundProvisionFailure } from '../../services/provisionFailure.ts';
import { decodeNodeRef } from '../../utils/nodeRef.ts';
import { imageDeployTargets, defaultStorageForHost } from '../../utils/cloudImageTargets.ts';
import { checkVlanAssignment } from '../../utils/vlanAccess.ts';
import { assertStorageExposed, filterExposedStorages } from '../../utils/storageVisibility.ts';
import { computeCpuTopology } from '../../utils/cpuTopology.ts';
import { assertNodeCapacity } from '../../utils/capacity.ts';
import { assertNodeAvailable } from '../../utils/nodeMaintenance.ts';
import { assertUserQuota } from '../../utils/quota.ts';
import { toPveVmName } from '../../utils/vmName.ts';
import { startBackgroundWork } from '../../services/backgroundWork.ts';
import { submitProvision } from '../../services/provisionOwnership.ts';
import { getCloudImageVirtualSizeGb } from '../../utils/cloudImageSize.ts';
import { serializeNodeIdentity, stepList, parseCloudInitOptions, loadProvisioner } from './shared.ts';
import { releaseCapacityAfter, finishImageProvision } from './tasks.ts';

const router = Router();

// ─── Automatic placement for non-admin cloud-image deploys ───────────────────
// The same image (same download URL) may be present on several hosts. Rank
// candidate hosts by guest count (fewest first) and take the first one that
// actually has room: reachable, an images-capable storage with the most free
// space, and enough capacity (assertNodeCapacity). A nearly-full host is
// skipped even when it has fewer VMs — count never beats capacity.
//
// Every skipped host records *why* it was skipped, so a placement failure comes
// back as something the user (and the admin they escalate to) can act on rather
// than a dead end.

// Trim an upstream message down to something safe and readable in a 503 body.
// Our own pre-flight errors carry err.status and a user-facing message; anything
// else is an upstream failure and gets scrubbed of hosts/URLs first.
function placementSkipReason(err: any) {
  const raw = err?.status ? err.message : sanitizeError(err?.message);
  const text = String(raw || 'unavailable').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

async function autoPlaceImage(image: any, { memoryMb, diskGb }: any) {
  const rows = await db.select().from(cloudImages)
    .where(and(
      eq(cloudImages.status, 'ready'),
      ne(cloudImages.volid, ''),
      notLike(cloudImages.volid, '%:iso/%'),
      eq(cloudImages.url, image.url),
    ));
  if (rows.length === 0) rows.push(image);

  // A host can be reachable via a per-host image row OR because it shares the
  // storage of a row's disk. Fold both into one candidate per host (first win),
  // carrying the volid as addressed on that host and that host's default pool.
  const byHost = new Map();
  for (const row of rows) {
    for (const t of await imageDeployTargets(row)) {
      if (!byHost.has(t.hostId)) {
        byHost.set(t.hostId, { node: t.nodeRef, volid: t.volid, default_storage: defaultStorageForHost(row, t.hostId) });
      }
    }
  }

  const vms = await getAllVMs();
  const countByHost = new Map();
  for (const vm of vms) countByHost.set(vm.hostId, (countByHost.get(vm.hostId) || 0) + 1);
  const ranked = [...byHost.entries()]
    .map(([hostId, info]: any) => ({ hostId, ...info }))
    .sort((a: any, b: any) => (countByHost.get(a.hostId) || 0) - (countByHost.get(b.hostId) || 0));

  const skipped: string[] = [];
  const skip = (nodeValue: any, reason: string) => {
    const label = decodeNodeRef(nodeValue).nodeName || String(nodeValue);
    skipped.push(`${label} — ${reason}`);
    log('warn', 'placement_node_skipped', { node: nodeValue, reason });
  };

  for (const cand of ranked) {
    try {
      // Nodes drained for maintenance never receive auto-placed VMs
      await assertNodeAvailable(cand.node);
      // getStorages doubles as the reachability gate — an offline host throws.
      // Users are placed only on storage pools an admin has exposed.
      const all = (await getStorages(cand.node)).filter((s: any) => s.content?.includes('images'));
      const exposed = await filterExposedStorages(cand.node, all, { isAdmin: false });
      exposed.sort((a: any, b: any) => (b.avail || 0) - (a.avail || 0));
      // The image's admin-set default storage wins when it's exposed here
      const preferred = exposed.find((s: any) => s.storage === cand.default_storage);
      const pick = preferred || exposed[0];
      if (!pick) {
        skip(cand.node, 'no VM storage pool is exposed to you on this host');
        continue;
      }
      // shortcut: this check does not reserve, so two concurrent auto-placed deploys can pick the same host and the loser fails at the reserving check in /from-image instead of moving to the next candidate; reserve here (and release on the early returns) if that shows up in practice.
      await assertNodeCapacity(cand.node, { memoryMb, diskGb, storage: pick.storage });
      return { image: { ...image, node: cand.node, volid: cand.volid }, storage: pick.storage };
    } catch (err) {
      skip(cand.node, placementSkipReason(err));
    }
  }
  return {
    error: {
      status: 503,
      message: skipped.length > 0
        ? `No Proxmox host could take this VM: ${skipped.join('; ')}. Ask your admin on Discord to make room.`
        : 'No Proxmox host currently carries this image — contact your admin on Discord.',
    },
  };
}

// ─── Create a VM directly from a cloud image (no static template) ────────────
//
// Builds a new VM whose boot disk is imported straight from a downloaded cloud
// image (import-from, PVE 7.3+), attaches a cloud-init drive + serial console,
// grows the disk, applies the requested cloud-init user/network, stamps
// owner/VLAN tags, and optionally starts it. The cloud image — not a Proxmox
// template — is the source artifact.

router.post('/from-image', async (req: any, res: any) => {
  const user = await loadProvisioner(req);
  if (!user?.is_admin && !user?.can_provision) {
    return res.status(403).json({ error: 'You do not have permission to provision VMs' });
  }

  const {
    imageId, name, cores = 2, memoryGb = 2, diskGb = 20,
    storage, bridge = 'vmbr0', description = '', assignTo, vlanTag, start = false, targetNode,
  } = req.body;

  if (!imageId || !name) {
    return res.status(400).json({ error: 'Image and name are required' });
  }

  // PVE VM names must be DNS-like — sanitize before reserving a VMID or running
  // the capacity/quota checks, so a bad name fails fast (utils/vmName.js).
  const vmName = toPveVmName(name);
  if (!vmName) {
    return res.status(400).json({ error: 'Name must contain letters or digits' });
  }

  // `bridge` and the resolved target storage are concatenated into Proxmox
  // property strings, so both must be strict identifiers (storage is validated
  // below, once the image and its default are known). Non-admins can't pick a
  // bridge (the networks list is admin-only) — pinning them to vmbr0 also blocks
  // a `bridge=vmbr0,tag=N` injection that would put the NIC on a VLAN the user
  // has no access to, bypassing the VLAN check below.
  const safeBridge = user.is_admin ? String(bridge || 'vmbr0') : 'vmbr0';
  if (!/^[a-zA-Z0-9._-]+$/.test(safeBridge)) {
    return res.status(400).json({ error: 'Invalid network bridge' });
  }

  const numericImageId = Number(imageId);
  const [image] = Number.isInteger(numericImageId)
    ? await db.select().from(cloudImages).where(eq(cloudImages.id, numericImageId)).limit(1)
    : [];
  if (!image) return res.status(404).json({ error: 'Cloud image not found' });
  if (image.status !== 'ready') {
    return res.status(400).json({ error: `Image is not ready (status: ${image.status})` });
  }
  if (!image.volid || image.volid.includes(':iso/')) {
    return res.status(400).json({ error: 'This image cannot be used as a disk source — remove it and add it again to re-download it as import content' });
  }

  // Resolve the disk target for admins: an explicit choice wins, else the
  // image's admin-set default. Validate here (the value is concatenated into
  // Proxmox property strings) now that the image — and thus its default — is
  // known. Non-admins get host AND storage from automatic placement below.
  let targetImage: any = image;
  let targetStorage = String(storage || image.default_storage || '').trim();
  if (user.is_admin) {
    if (!targetStorage) {
      return res.status(400).json({ error: 'Storage is required (this image has no default storage set)' });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(targetStorage)) {
      return res.status(400).json({ error: 'Invalid storage' });
    }
    // Admins may deploy onto any host the image is reachable from (its own
    // host, or a peer sharing its storage). Resolve the volid as addressed on
    // the chosen host; a target the image can't reach is rejected.
    if (targetNode && targetNode !== image.node) {
      const targets = await imageDeployTargets(image);
      const chosen = targets.find((t: any) => t.nodeRef === targetNode);
      if (!chosen) {
        return res.status(400).json({ error: 'The selected host cannot reach this image — it is not on storage shared with that host' });
      }
      targetImage = { ...image, node: chosen.nodeRef, volid: chosen.volid };
    }
  }

  const baseDiskGb = parseInt(diskGb, 10);
  if (!Number.isInteger(baseDiskGb) || baseDiskGb < 5) {
    return res.status(400).json({ error: 'Disk size must be at least 5 GB' });
  }
  const memoryMb = Math.round(parseFloat(memoryGb) * 1024);
  let imageDiskGb: number;
  try { imageDiskGb = Math.max(baseDiskGb, await getCloudImageVirtualSizeGb(image)); }
  catch (err) { return sendError(res, err); }

  // Placement: admins deploy onto the image's own host, or a shared-storage
  // peer they selected via targetNode (resolved above); non-admins land on the
  // least-loaded host that has room for the request.
  if (!user.is_admin) {
    const placed = await autoPlaceImage(image, { memoryMb, diskGb: imageDiskGb });
    if ('error' in placed) return res.status(placed.error.status).json({ error: placed.error.message });
    targetImage = placed.image;
    targetStorage = placed.storage;
  }
  if (targetImage.node !== image.node || targetImage.volid !== image.volid) {
    try { imageDiskGb = Math.max(baseDiskGb, await getCloudImageVirtualSizeGb(targetImage)); }
    catch (err) { return sendError(res, err); }
  }

  // Cloud images are always cloud-init capable, so guest settings are honored —
  // and a login credential is mandatory (the image ships with none).
  const parsed = await parseCloudInitOptions(req.body, req.session.userId, true);
  if ('error' in parsed) return res.status(parsed.error.status).json({ error: parsed.error.message });
  const cloudInitOpts = parsed.opts;

  // Authorize the target VLAN. Non-admins must place the VM on a VLAN assigned
  // to them; the untagged/native network is admin-only (utils/vlanAccess.js).
  const vlanErr = await checkVlanAssignment(db, { userId: req.session.userId, isAdmin: !!user.is_admin, vlanTag });
  if (vlanErr) return res.status(vlanErr.status).json({ error: vlanErr.error });

  // Enforce storage exposure — never trust the dropdown. Non-admins can't
  // deploy onto a pool an admin has hidden, even by naming it directly.
  try {
    await assertStorageExposed(targetImage.node, targetStorage, user);
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  // Refuse deployment to a node the admin has drained for maintenance
  try {
    await assertNodeAvailable(targetImage.node);
  } catch (err) {
    return sendError(res, err);
  }

  // CPU topology + node capacity checks run on the placed node (import-from
  // requires the disk source and target to share a host).
  let cpuLayout;
  try {
    cpuLayout = await computeCpuTopology(targetImage.node, cores);
  } catch (err) {
    if (hasHttpStatus(err)) return sendError(res, err);
    // Non-validation error — fall back to a plain socket/core split
    cpuLayout = { sockets: 1, cores: parseInt(cores, 10) || 2 };
  }

  let capacityNote = '';
  // Held from the capacity check until the deploy job ends (#284).
  let releaseCapacity = () => {};
  try {
    const capacity = await assertNodeCapacity(targetImage.node, { memoryMb, diskGb: imageDiskGb, storage: targetStorage, reserve: true });
    capacityNote = capacity.memoryWarning;
    releaseCapacity = capacity.release;
    // Per-user resource quota (skips admins / users without quotas)
    await assertUserQuota(req.session.userId, {
      addCores: cpuLayout.sockets * cpuLayout.cores,
      addMemoryMb: memoryMb,
      addDiskGb: imageDiskGb,
    });
  } catch (err) {
    releaseCapacity();
    if (hasHttpStatus(err)) return sendError(res, err);
    throw err;
  }

  try {
    const tag = vlanTag ? parseInt(vlanTag) : null;

    // Late allocation + reservation (see /clone above): concurrent deploys can
    // no longer be handed the same id, and a failed create hands its id back.
    const submit = (onReserved: (vmid: number) => Promise<void>, marker: string) => withFreshVmid((id: number) => createVM(targetImage.node, id, {
      name: vmName,
      cpu: 'host',
      sockets: cpuLayout.sockets,
      cores: cpuLayout.cores,
      memory: memoryMb,
      ostype: 'l26',
      scsihw: 'virtio-scsi-single',
      scsi0: `${targetStorage}:0,import-from=${targetImage.volid}`,
      ide2: `${targetStorage}:cloudinit`,
      boot: 'order=scsi0',
      serial0: 'socket',
      vga: 'serial0',
      net0: tag ? `virtio,bridge=${safeBridge},tag=${tag}` : `virtio,bridge=${safeBridge}`,
      description: `${description}\n${marker}`,
    }), { onReserved });

    const startNow = !!start;
    const steps = stepList([
      { key: 'reserve', label: 'Reserving VMID', status: 'done' },
      { key: 'capacity', label: 'Checking node capacity', status: 'done', note: capacityNote },
      { key: 'create', label: 'Creating VM & importing cloud image', status: 'active' },
      { key: 'resize', label: 'Resizing disk', status: 'pending' },
      { key: 'cloudinit', label: 'Applying cloud-init config', status: 'pending' },
      { key: 'tags', label: 'Applying owner / VLAN tags', status: 'pending' },
      { key: 'start', label: startNow ? 'Starting VM' : 'Finalizing', status: 'pending' },
    ]);
    const targetUser = user.is_admin ? (assignTo ? Number(assignTo) : null) : req.session.userId;
    const { provisionId, vmid, upid } = await submitProvision({
      user_id: req.session.userId, node: targetImage.node, vmid: 0, name: vmName,
      source_type: 'cloudimage', cloud_image_id: targetImage.id, steps, status: 'creating', request_id: req.requestId || '',
    }, {
      userId: targetUser, createdBy: req.session.username,
      cores: cpuLayout.sockets * cpuLayout.cores, memoryMb, diskGb: imageDiskGb,
    }, submit);

    startBackgroundWork(() => finishImageProvision(provisionId, targetImage.node, vmid, upid, {
      diskGb: imageDiskGb,
      ...cloudInitOpts,
      start: startNow,
    }), { kind: 'provision', id: provisionId, requestId: req.requestId })
      .catch((err: any) => recordBackgroundProvisionFailure(provisionId, vmid, 'provision_image_background_failed', err))
      .finally(() => releaseCapacityAfter(targetImage.node, upid, releaseCapacity));

    await logAudit(req, 'vm_from_image', `${targetImage.node}/${vmid}`, `image:${targetImage.name}${user.is_admin ? '' : ' (auto-placed)'}`);
    res.json({
      id: provisionId,
      vmid,
      ...serializeNodeIdentity(targetImage.node),
      status: 'creating',
      upid,
    });
  } catch (err: any) {
    releaseCapacity();
    // An unreachable host makes VMID allocation unsafe rather than broken —
    // report it as "try again later" instead of a flat 500.
    if (!hasHttpStatus(err) && err.message?.includes('globally unique VMID')) tagStatus(err, 503);
    sendError(res, err);
  }
});

export default router;
