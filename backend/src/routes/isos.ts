import { Router } from 'express';
import db from '../db.ts';
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

function serializeIso(row) {
  const { nodeName, nodeRef } = decodeNodeRef(row.node);
  return { ...row, node: nodeName || row.node, nodeRef: nodeRef || row.node };
}

function setIsoStatus(id, status, detail = '') {
  db.prepare('UPDATE isos SET status = ?, status_detail = ? WHERE id = ?').run(status, detail, id);
}

async function waitForTask(node, upid, { attempts = 240, intervalMs = 5000 } = {}) {
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

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM isos ORDER BY name').all();
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
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'iso';

  const row = db.prepare(
    'INSERT INTO isos (name, url, node, storage, status, request_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, url, node, storage, 'downloading', req.requestId || '');
  const id = row.lastInsertRowid;
  // ISO content: PVE requires the stored filename to carry the .iso extension.
  // The unique suffix avoids clobbering a file already on the storage.
  const filename = `${slug}-iso${id}.iso`;
  const volid = `${storage}:iso/${filename}`;

  try {
    const upid = await downloadUrlToStorage(node, storage, url, filename, checksum?.trim() || undefined, undefined, 'iso');
    db.prepare('UPDATE isos SET volid = ?, upid = ? WHERE id = ?').run(volid, upid || '', id);
    logAudit(req, 'iso_download', name, `storage=${storage}; requestId=${req.requestId || ''}`);

    // Poll in the background; the row's status is the source of truth for the UI
    startBackgroundWork(async () => {
      const result = await waitForTask(node, upid);
      if (!result.ok) {
        setIsoStatus(id, 'error', result.exitstatus === 'timeout'
          ? 'Timed out waiting for the download'
          : `Download failed: ${result.exitstatus}`);
        return;
      }
      try {
        const content = await getStorageContent(node, storage, 'iso');
        const vol = content.find((c) => c.volid === volid);
        if (!vol) {
          setIsoStatus(id, 'error', 'Download finished but the ISO was not found on the storage');
          return;
        }
        db.prepare('UPDATE isos SET status = ?, status_detail = ?, size = ? WHERE id = ?')
          .run('ready', '', vol.size || 0, id);
      } catch (err) {
        setIsoStatus(id, 'error', `Could not verify download: ${sanitizeError(err.message)}`);
      }
    }, { kind: 'iso-download', id, requestId: req.requestId })
      .catch((err) => setIsoStatus(id, 'error', sanitizeError(err.message)));

    res.json({ id, status: 'downloading' });
  } catch (err) {
    setIsoStatus(id, 'error', sanitizeError(err.message));
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/:id', async (req, res) => {
  const iso = db.prepare('SELECT * FROM isos WHERE id = ?').get(req.params.id);
  if (!iso) return res.status(404).json({ error: 'ISO not found' });
  if (iso.volid) {
    try {
      await deleteVolume(iso.node, iso.volid);
    } catch (err) {
      // Already gone is fine; anything else should stop the delete so we
      // don't leave an orphaned multi-GB file on the storage.
      if (!/does not exist|no such|not found/i.test(err.message)) {
        return res.status(500).json({ error: sanitizeError(err.message) });
      }
    }
  }
  db.prepare('DELETE FROM isos WHERE id = ?').run(req.params.id);
  logAudit(req, 'iso_delete', iso.name, iso.volid);
  res.json({ ok: true });
});

export default router;
