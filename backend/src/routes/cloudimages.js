import { Router } from 'express';
import db from '../db.js';
import {
  downloadUrlToStorage, deleteVolume, convertToTemplate,
  getTaskStatus, getISOImages, getNextVmid, createVM, resizeVMDisk,
} from '../proxmox.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { decodeNodeRef } from '../utils/nodeRef.js';

const router = Router();
router.use(requireAuth);
router.use(requirePermission('can_manage_templates'));

function serializeImage(row) {
  const { nodeName, nodeRef } = decodeNodeRef(row.node);
  return { ...row, node: nodeName || row.node, nodeRef: nodeRef || row.node };
}

function setImageStatus(id, status, detail = '') {
  db.prepare('UPDATE cloud_images SET status = ?, status_detail = ? WHERE id = ?').run(status, detail, id);
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
  const rows = db.prepare('SELECT * FROM cloud_images ORDER BY name').all();
  res.json(rows.map(serializeImage));
});

// Start downloading a cloud image onto a PVE storage
router.post('/', async (req, res) => {
  const { name, url, node, storage, checksum } = req.body;
  if (!name || !url || !node || !storage) {
    return res.status(400).json({ error: 'name, url, node and storage are required' });
  }
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL must be http(s)' });
  }

  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cloud-image';

  const row = db.prepare(
    'INSERT INTO cloud_images (name, url, node, storage, status) VALUES (?, ?, ?, ?, ?)'
  ).run(name, url, node, storage, 'downloading');
  const id = row.lastInsertRowid;
  // Stored as ISO content; unique suffix avoids clobbering an existing file
  const filename = `${slug}-ci${id}.img`;
  const volid = `${storage}:iso/${filename}`;

  try {
    const upid = await downloadUrlToStorage(node, storage, url, filename, checksum?.trim() || undefined);
    db.prepare('UPDATE cloud_images SET volid = ?, upid = ? WHERE id = ?').run(volid, upid || '', id);
    logAudit(req, 'cloud_image_download', name, url);

    // Poll in the background; the row's status is the source of truth for the UI
    (async () => {
      const result = await waitForTask(node, upid);
      if (!result.ok) {
        setImageStatus(id, 'error', result.exitstatus === 'timeout'
          ? 'Timed out waiting for the download'
          : `Download failed: ${result.exitstatus}`);
        return;
      }
      try {
        const content = await getISOImages(node, storage);
        const vol = content.find((c) => c.volid === volid);
        if (!vol) {
          setImageStatus(id, 'error', 'Download finished but the image was not found on the storage');
          return;
        }
        db.prepare('UPDATE cloud_images SET status = ?, status_detail = ?, size = ? WHERE id = ?')
          .run('ready', '', vol.size || 0, id);
      } catch (err) {
        setImageStatus(id, 'error', `Could not verify download: ${err.message}`);
      }
    })().catch((err) => setImageStatus(id, 'error', err.message));

    res.json({ id, status: 'downloading' });
  } catch (err) {
    setImageStatus(id, 'error', sanitizeError(err.message));
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

router.delete('/:id', async (req, res) => {
  const image = db.prepare('SELECT * FROM cloud_images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (image.status === 'templating') {
    return res.status(400).json({ error: 'A template is being created from this image — wait for it to finish' });
  }
  if (image.volid) {
    try {
      await deleteVolume(image.node, image.volid);
    } catch (err) {
      // Already gone is fine; anything else should stop the delete so we
      // don't leave an orphaned multi-GB file on the storage.
      if (!/does not exist|no such|not found/i.test(err.message)) {
        return res.status(500).json({ error: sanitizeError(err.message) });
      }
    }
  }
  db.prepare('DELETE FROM cloud_images WHERE id = ?').run(req.params.id);
  logAudit(req, 'cloud_image_delete', image.name, image.volid);
  res.json({ ok: true });
});

// ─── Build a cloud-init template from a downloaded image ─────────────────────
//
// Creates a VM whose boot disk is imported from the image (import-from,
// needs PVE 7.3+), attaches a cloud-init drive and serial console, grows the
// disk to the requested base size, converts the VM to a template, and
// registers it in vm_templates so the normal clone flow picks it up.

router.post('/:id/template', async (req, res) => {
  const image = db.prepare('SELECT * FROM cloud_images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (image.status !== 'ready') {
    return res.status(400).json({ error: `Image is not ready (status: ${image.status})` });
  }

  const {
    name, storage, diskGb = 10, cores = 2, memoryGb = 2, bridge = 'vmbr0',
  } = req.body;
  if (!name || !storage) {
    return res.status(400).json({ error: 'Template name and target storage are required' });
  }
  const baseDiskGb = parseInt(diskGb, 10);
  const memoryMb = Math.round(parseFloat(memoryGb) * 1024);
  if (!Number.isInteger(baseDiskGb) || baseDiskGb < 3) {
    return res.status(400).json({ error: 'Disk size must be at least 3 GB (cloud images are ~2–3 GB)' });
  }

  try {
    const vmid = await getNextVmid();
    const upid = await createVM(image.node, vmid, {
      name: String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || `cloud-template-${vmid}`,
      cpu: 'host',
      cores: parseInt(cores, 10) || 2,
      memory: memoryMb,
      ostype: 'l26',
      scsihw: 'virtio-scsi-single',
      scsi0: `${storage}:0,import-from=${image.volid}`,
      ide2: `${storage}:cloudinit`,
      boot: 'order=scsi0',
      serial0: 'socket',
      vga: 'serial0',
      net0: `virtio,bridge=${bridge}`,
      ipconfig0: 'ip=dhcp',
      description: `Cloud-init template built from ${image.name} (${image.url})`,
    });

    setImageStatus(image.id, 'templating', `Creating template "${name}" (VMID ${vmid})…`);
    logAudit(req, 'cloud_image_template', `${image.node}/${vmid}`, `image:${image.name} name:${name}`);

    (async () => {
      const result = await waitForTask(image.node, upid);
      if (!result.ok) {
        setImageStatus(image.id, 'ready', `Template creation failed (VMID ${vmid}): ${result.exitstatus}`);
        return;
      }
      const warnings = [];
      try {
        await resizeVMDisk(image.node, vmid, 'scsi0', `${baseDiskGb}G`);
      } catch (err) {
        warnings.push(`disk resize failed: ${err.message}`);
      }
      try {
        await convertToTemplate(image.node, vmid);
      } catch (err) {
        setImageStatus(image.id, 'ready', `VM ${vmid} imported but template conversion failed: ${err.message}`);
        return;
      }
      db.prepare(`
        INSERT INTO vm_templates (name, description, node, vmid, default_cores, default_memory, default_disk_gb, default_storage, cloud_init, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      `).run(
        name,
        `Cloud-init template from ${image.name}`,
        image.node, vmid,
        parseInt(cores, 10) || 2, memoryMb, baseDiskGb, storage,
      );
      setImageStatus(image.id, 'ready', warnings.length
        ? `Template "${name}" (VMID ${vmid}) created — ${warnings.join('; ')}`
        : `Template "${name}" (VMID ${vmid}) created`);
    })().catch((err) => setImageStatus(image.id, 'ready', `Template creation failed: ${err.message}`));

    res.json({ vmid, status: 'templating' });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
