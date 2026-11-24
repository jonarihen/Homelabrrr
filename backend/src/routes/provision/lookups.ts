import { Router } from 'express';
import { and, eq, ne, notLike } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vmTemplates, cloudImages, pveHosts } from '../../db/schema/index.ts';
import { getStorages, getISOImages, getNetworks, getNodes } from '../../proxmox.ts';
import { requireAdmin, requirePermission } from '../../middleware/auth.ts';
import { sendError } from '../../utils/httpError.ts';
import { decodeNodeRef } from '../../utils/nodeRef.ts';
import { imageDeployTargets, defaultStorageForHost } from '../../utils/cloudImageTargets.ts';
import { assertStorageExposed, filterExposedStorages } from '../../utils/storageVisibility.ts';
import { getUserQuota, getUserResourceUsage } from '../../utils/quota.ts';
import { loadProvisioner } from './shared.ts';

const router = Router();

// ─── Own quota + current usage (any authenticated user) ─────────────────────

router.get('/quota', async (req: any, res: any) => {
  try {
    const quota = await getUserQuota(req.session.userId);
    if (!quota) return res.status(401).json({ error: 'Unauthorized' });
    const usage = await getUserResourceUsage(req.session.userId);
    res.json({
      usage,
      limits: quota.isAdmin
        ? { maxCores: null, maxMemoryGb: null, maxStorageGb: null }
        : { maxCores: quota.maxCores, maxMemoryGb: quota.maxMemoryGb, maxStorageGb: quota.maxStorageGb },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Templates (public, read-only for users) ────────────────────────────────

router.get('/templates', async (req: any, res: any) => {
  const templates = await db.select().from(vmTemplates)
    .where(eq(vmTemplates.enabled, true))
    .orderBy(vmTemplates.name);
  res.json(templates.map((t: any) => ({
    ...t,
    nodeRef: t.node,
    node: decodeNodeRef(t.node).nodeName || t.node,
  })));
});

// ─── Cloud images available to provision directly (read-only, provisioners) ──

router.get('/images', async (req: any, res: any) => {
  const user = await loadProvisioner(req);
  if (!user?.is_admin && !user?.can_provision) {
    return res.status(403).json({ error: 'You do not have permission to provision VMs' });
  }
  // Only ready images stored as import content can be used as an import-from
  // disk source; iso-content rows (downloaded before the import switch) can't.
  const rows = await db.select({
    id: cloudImages.id, name: cloudImages.name, url: cloudImages.url, node: cloudImages.node,
    storage: cloudImages.storage, default_storage: cloudImages.default_storage,
    default_storage_map: cloudImages.default_storage_map, volid: cloudImages.volid, size: cloudImages.size,
  }).from(cloudImages)
    .where(and(eq(cloudImages.status, 'ready'), ne(cloudImages.volid, ''), notLike(cloudImages.volid, '%:iso/%')))
    .orderBy(cloudImages.name);
  const hostRows = await db.select({ id: pveHosts.id, name: pveHosts.name }).from(pveHosts);
  const hostNames = new Map(hostRows.map((h) => [h.id, h.name]));
  const out = [];
  for (const r of rows) {
    const { hostId, nodeName, nodeRef } = decodeNodeRef(r.node);
    // Every host this image can be deployed from — its own host plus any peer
    // sharing its storage. Each target carries the per-host default target pool
    // so the deploy form can pre-select it as the host is switched.
    const targets = (await imageDeployTargets(r)).map((t: any) => ({
      nodeRef: t.nodeRef, node: t.node, hostId: t.hostId, hostName: hostNames.get(t.hostId) || '',
      defaultStorage: defaultStorageForHost(r, t.hostId) || '',
    }));
    out.push({
      id: r.id, name: r.name, url: r.url, storage: r.storage, default_storage: r.default_storage || '', size: r.size,
      node: nodeName || r.node, nodeRef: nodeRef || r.node,
      hostName: (hostId && hostNames.get(hostId)) || '',
      deployTargets: targets,
    });
  }
  res.json(out);
});

// ─── Proxmox resources (for form dropdowns) ─────────────────────────────────

// can_create_vms holders need the node list to pick a deploy target for the
// from-scratch flow (same nodes the admin create form uses).
router.get('/nodes', requirePermission('can_manage_templates', 'can_create_vms'), async (req: any, res: any) => {
  try {
    res.json(await getNodes());
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/nodes/:node/storages', requirePermission('can_provision', 'can_manage_templates', 'can_create_vms'), async (req: any, res: any) => {
  try {
    const storages = await getStorages(req.params.node);
    // Non-admins only see storage pools an admin has exposed. Admins see all.
    const visible = await filterExposedStorages(req.params.node, storages, { isAdmin: req.session.isAdmin });
    res.json(visible);
  } catch (err) {
    sendError(res, err);
  }
});

// Open to can_create_vms so from-scratch users can pick a boot ISO. Non-admins
// may only list ISOs from storages an admin has exposed (mirrors the
// disk-storage picker).
router.get('/nodes/:node/isos/:storage', requirePermission('can_create_vms'), async (req: any, res: any) => {
  try {
    await assertStorageExposed(req.params.node, req.params.storage, { isAdmin: req.session.isAdmin });
    res.json(await getISOImages(req.params.node, req.params.storage));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/nodes/:node/networks', requireAdmin, async (req: any, res: any) => {
  try {
    res.json(await getNetworks(req.params.node));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
