import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { isos } from '../db/schema/index.ts';
import {
  downloadUrlToStorage, deleteVolume, getTaskStatus, getStorageContent,
} from '../proxmox.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { logAudit } from '../utils/audit.ts';
import { decodeNodeRef } from '../utils/nodeRef.ts';
import { assertPublicDownloadUrl } from '../utils/urlGuard.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';

const router = Router();
router.use(requireAuth);
// Same gate as cloud images. If a dedicated ISO/media permission lands (#14),
// swap this for it — until then reuse can_manage_templates so the catalog is
// managed by the same admins who curate templates and cloud images.
router.use(requirePermission('can_manage_templates'));

function serializeIso(row: any) {
  const { nodeName, nodeRef } = decodeNodeRef(row.node);
  return { ...row, node: nodeName || row.node, nodeRef: nodeRef || row.node };
}

async function setIsoStatus(id: number, status: string, detail = '') {
  await db.update(isos).set({ status, status_detail: detail }).where(eq(isos.id, id));
}

async function waitForTask(node: string, upid: string, { attempts = 240, intervalMs = 5000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const task = await getTaskStatus(node, upid);
      if (task.status === 'stopped') {
        return { ok: task.exitstatus === 'OK', exitstatus: task.exitstatus || '' };
      }
    } catch { /* keep polling */ }
  }
  return { ok: false, exitstatus: 'timeout' };
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const rows = await db.select().from(isos).orderBy(isos.name);
  res.json(rows.map(serializeIso));
});

// Start downloading an installer ISO onto a PVE storage
router.post('/', async (req, res) => {
  const { name, url, node, storage, checksum } = req.body;
  if (!name || !url || !node || !storage) {
    return res.status(400).json({ error: 'name, url, node and storage are required' });
  }
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL must be http(s)' });
  }
  // The PVE host fetches this URL server-side — refuse internal targets (SSRF)
  try {
    await assertPublicDownloadUrl(url);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'iso';

  const [inserted] = await db.insert(isos).values({
    name, url, node, storage, status: 'downloading', request_id: req.requestId || '',
  }).returning({ id: isos.id });
  const id = inserted.id;
  // ISO content: PVE requires the stored filename to carry the .iso extension.
  // The unique suffix avoids clobbering a file already on the storage.
  const filename = `${slug}-iso${id}.iso`;
  const volid = `${storage}:iso/${filename}`;

  try {
    const upid = await downloadUrlToStorage(node, storage, url, filename, checksum?.trim() || undefined, undefined, 'iso');
    await db.update(isos).set({ volid, upid: upid || '' }).where(eq(isos.id, id));
    await logAudit(req, 'iso_download', name, `storage=${storage}; requestId=${req.requestId || ''}`);

    // Poll in the background; the row's status is the source of truth for the UI
    startBackgroundWork(async () => {
      const result = await waitForTask(node, upid);
      if (!result.ok) {
        await setIsoStatus(id, 'error', result.exitstatus === 'timeout'
          ? 'Timed out waiting for the download'
          : `Download failed: ${result.exitstatus}`);
        return;
      }
      try {
        const content = await getStorageContent(node, storage, 'iso');
        const vol = content.find((c: any) => c.volid === volid);
        if (!vol) {
          await setIsoStatus(id, 'error', 'Download finished but the ISO was not found on the storage');
          return;
        }
        await db.update(isos).set({ status: 'ready', status_detail: '', size: vol.size || 0 }).where(eq(isos.id, id));
      } catch (err: any) {
        await setIsoStatus(id, 'error', `Could not verify download: ${sanitizeError(err.message)}`);
      }
    }, { kind: 'iso-download', id, requestId: req.requestId })
      .catch((err: any) => { setIsoStatus(id, 'error', sanitizeError(err.message)).catch(() => {}); });

    res.json({ id, status: 'downloading' });
  } catch (err: any) {
    await setIsoStatus(id, 'error', sanitizeError(err.message));
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'ISO not found' });
  const [iso] = await db.select().from(isos).where(eq(isos.id, id)).limit(1);
  if (!iso) return res.status(404).json({ error: 'ISO not found' });
  if (iso.volid) {
    try {
      await deleteVolume(iso.node, iso.volid);
    } catch (err: any) {
      // Already gone is fine; anything else should stop the delete so we
      // don't leave an orphaned multi-GB file on the storage.
      if (!/does not exist|no such|not found/i.test(err.message)) {
        return res.status(500).json({ error: sanitizeError(err.message) });
      }
    }
  }
  await db.delete(isos).where(eq(isos.id, id));
  await logAudit(req, 'iso_delete', iso.name, iso.volid);
  res.json({ ok: true });
});

export default router;
