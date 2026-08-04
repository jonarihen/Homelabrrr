import { Router } from 'express';
import db from '../db.js';
import {
  downloadUrlToStorage, deleteVolume, convertToTemplate,
  getTaskStatus, getStorageContent, withFreshVmid, createVM, resizeVMDisk, getHost,
} from '../proxmox.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { decodeNodeRef } from '../utils/nodeRef.js';
import { assertPublicDownloadUrl } from '../utils/urlGuard.js';
import { imageDeployTargets } from '../utils/cloudImageTargets.js';
import { hostHasSsh, runNodeCommands } from '../utils/pveSsh.js';
import { startBackgroundWork } from '../services/backgroundWork.js';

const router = Router();
router.use(requireAuth);
router.use(requirePermission('can_manage_templates'));

function serializeImage(row) {
  const { nodeName, nodeRef } = decodeNodeRef(row.node);
  let defaultStorageMap = {};
  try { defaultStorageMap = row.default_storage_map ? JSON.parse(row.default_storage_map) : {}; } catch { defaultStorageMap = {}; }
  return { ...row, node: nodeName || row.node, nodeRef: nodeRef || row.node, defaultStorageMap };
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

router.get('/', async (req, res) => {
  const rows = db.prepare('SELECT * FROM cloud_images ORDER BY name').all();
  const hostNames = new Map(db.prepare('SELECT id, name FROM pve_hosts').all().map((h) => [h.id, h.name]));
  const out = [];
  for (const row of rows) {
    const img = serializeImage(row);
    // Deploy targets (own host + shared-storage peers) power the per-host
    // default-storage editor. Only meaningful for ready, disk-usable images.
    if (row.status === 'ready' && row.volid && !row.volid.includes(':iso/')) {
      img.deployTargets = (await imageDeployTargets(row)).map((t) => ({
        hostId: t.hostId, nodeRef: t.nodeRef, node: t.node, hostName: hostNames.get(t.hostId) || '',
      }));
    } else {
      img.deployTargets = [];
    }
    out.push(img);
  }
  res.json(out);
});

// Start downloading a cloud image onto a PVE storage
router.post('/', async (req, res) => {
  const { name, url, node, storage, checksum, defaultStorage } = req.body;
  if (!name || !url || !node || !storage) {
    return res.status(400).json({ error: 'name, url, node and storage are required' });
  }
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL must be http(s)' });
  }
  // Optional default *target* storage for direct-from-image provisioning.
  const defStore = String(defaultStorage || '').trim();
  if (defStore && !/^[a-zA-Z0-9._-]+$/.test(defStore)) {
    return res.status(400).json({ error: 'Invalid default storage' });
  }
  // Seed the per-host default map with the download host's choice. Other hosts
  // (for shared-storage images) are set later from the Default storage editor.
  const { hostId: dlHostId } = decodeNodeRef(node);
  const defStoreMap = defStore && dlHostId != null ? JSON.stringify({ [dlHostId]: defStore }) : '';
  // The PVE host fetches this URL server-side — refuse internal targets (SSRF)
  try {
    await assertPublicDownloadUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cloud-image';

  const row = db.prepare(
    'INSERT INTO cloud_images (name, url, node, storage, default_storage, default_storage_map, status, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, url, node, storage, defStore, defStoreMap, 'downloading', req.requestId || '');
  const id = row.lastInsertRowid;
  // Stored as `import` content; the unique suffix avoids clobbering an
  // existing file. PVE derives the disk format from the extension, and
  // distro ".img" cloud images are qcow2 inside, so they are stored as
  // .qcow2 (raw images are published as .raw).
  const srcExt = (url.split('?')[0].match(/\.(qcow2|raw|vmdk|img)$/i)?.[1] || 'qcow2').toLowerCase();
  const filename = `${slug}-ci${id}.${srcExt === 'img' ? 'qcow2' : srcExt}`;
  const volid = `${storage}:import/${filename}`;

  try {
    const upid = await downloadUrlToStorage(node, storage, url, filename, checksum?.trim() || undefined);
    db.prepare('UPDATE cloud_images SET volid = ?, upid = ? WHERE id = ?').run(volid, upid || '', id);
    logAudit(req, 'cloud_image_download', name, `storage=${storage}; requestId=${req.requestId || ''}`);

    // Poll in the background; the row's status is the source of truth for the UI
    startBackgroundWork(async () => {
      const result = await waitForTask(node, upid);
      if (!result.ok) {
        setImageStatus(id, 'error', result.exitstatus === 'timeout'
          ? 'Timed out waiting for the download'
          : `Download failed: ${result.exitstatus}`);
        return;
      }
      try {
        const content = await getStorageContent(node, storage, 'import');
        const vol = content.find((c) => c.volid === volid);
        if (!vol) {
          setImageStatus(id, 'error', 'Download finished but the image was not found on the storage');
          return;
        }
        db.prepare('UPDATE cloud_images SET status = ?, status_detail = ?, size = ? WHERE id = ?')
          .run('ready', '', vol.size || 0, id);
      } catch (err) {
        setImageStatus(id, 'error', `Could not verify download: ${sanitizeError(err.message)}`);
      }
    }, { kind: 'cloud-image-download', id, requestId: req.requestId })
      .catch((err) => setImageStatus(id, 'error', sanitizeError(err.message)));

    res.json({ id, status: 'downloading' });
  } catch (err) {
    setImageStatus(id, 'error', sanitizeError(err.message));
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// Update an image's default *target* storage (used to pre-select/fall back the
// disk target when deploying a VM directly from this image). Empty clears it.
router.put('/:id', (req, res) => {
  const image = db.prepare('SELECT * FROM cloud_images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });

  // Per-host default map: { hostId: storageId }. Validate ids and pool names;
  // empty values drop that host's entry. The image's own download host also
  // populates the legacy `default_storage` column so older callers still work.
  if (req.body?.defaultStorageMap !== undefined) {
    const incoming = req.body.defaultStorageMap || {};
    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'defaultStorageMap must be an object' });
    }
    const clean = {};
    for (const [hostId, store] of Object.entries(incoming)) {
      if (!/^\d+$/.test(String(hostId))) return res.status(400).json({ error: 'Invalid host id' });
      const s = String(store || '').trim();
      if (!s) continue;
      if (!/^[a-zA-Z0-9._-]+$/.test(s)) return res.status(400).json({ error: `Invalid storage for host ${hostId}` });
      clean[hostId] = s;
    }
    const { hostId: ownHostId } = decodeNodeRef(image.node);
    const legacy = (ownHostId != null && clean[ownHostId]) || '';
    db.prepare('UPDATE cloud_images SET default_storage_map = ?, default_storage = ? WHERE id = ?')
      .run(Object.keys(clean).length ? JSON.stringify(clean) : '', legacy, req.params.id);
    logAudit(req, 'cloud_image_update', image.name, `default_storage_map=${JSON.stringify(clean)}`);
    return res.json({ ok: true });
  }

  // Legacy single-value update (own-host default only).
  const defStore = String(req.body?.defaultStorage ?? '').trim();
  if (defStore && !/^[a-zA-Z0-9._-]+$/.test(defStore)) {
    return res.status(400).json({ error: 'Invalid default storage' });
  }
  const { hostId: ownHostId } = decodeNodeRef(image.node);
  let map = {};
  try { map = image.default_storage_map ? JSON.parse(image.default_storage_map) : {}; } catch { map = {}; }
  if (ownHostId != null) {
    if (defStore) map[ownHostId] = defStore; else delete map[ownHostId];
  }
  db.prepare('UPDATE cloud_images SET default_storage = ?, default_storage_map = ? WHERE id = ?')
    .run(defStore, Object.keys(map).length ? JSON.stringify(map) : '', req.params.id);
  logAudit(req, 'cloud_image_update', image.name, `default_storage=${defStore || '(none)'}`);
  res.json({ ok: true });
});

// Single-quote a string for safe embedding in a POSIX shell command.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Runs inside the guest image via `virt-customize --run-command`. Disables the
// systemd v257+ OSC 3008 shell drop-in (which spams the Proxmox VT console)
// using a dpkg diversion so a package update can't reinstate it. No-op and safe
// on images without the file (older systemd) or without dpkg (non-Debian).
const OSC_GUEST_CMD = 'f=/usr/lib/systemd/profile.d/80-systemd-osc-context.sh; '
  + 'if [ ! -e "$f" ]; then echo HL_NOT_NEEDED; '
  + 'elif command -v dpkg-divert >/dev/null 2>&1 && dpkg-divert --list "$f" | grep -q .; then echo HL_ALREADY; '
  + 'elif command -v dpkg-divert >/dev/null 2>&1; then dpkg-divert --local --rename --add "$f" && echo HL_PATCHED; '
  + 'else rm -f "$f" && echo HL_PATCHED; fi';

// Patch a downloaded image so VMs deployed from it have a clean Proxmox console.
// Runs virt-customize on the image's host over SSH (host SSH must be configured;
// libguestfs-tools must be installed on the host). Background — the UI polls the
// image's console_patch_status.
router.post('/:id/patch-console', async (req, res) => {
  const image = db.prepare('SELECT * FROM cloud_images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (image.status !== 'ready' || !image.volid || image.volid.includes(':iso/')) {
    return res.status(400).json({ error: 'Image is not a ready disk image' });
  }
  if (image.console_patch_status === 'patching') {
    return res.status(409).json({ error: 'Already patching this image' });
  }
  const { hostId } = decodeNodeRef(image.node);
  const host = hostId != null ? getHost(hostId) : null;
  if (!hostHasSsh(host)) {
    return res.status(400).json({ error: "Configure SSH for this image's host (Admin → PVE Hosts) — patching runs virt-customize on the host" });
  }

  const storageId = image.volid.split(':')[0];
  const rel = image.volid.slice(storageId.length + 1);
  // Both come from our own download flow (identifier storage id, slugged
  // filename), but guard anyway since the value is interpolated into a shell path.
  if (!/^[a-zA-Z0-9._-]+$/.test(storageId) || !/^[a-zA-Z0-9._/-]+$/.test(rel) || rel.includes('..')) {
    return res.status(400).json({ error: 'Image volume path is not patchable' });
  }
  const imgPath = `/mnt/pve/${storageId}/${rel}`;

  db.prepare("UPDATE cloud_images SET console_patch_status = 'patching', console_patch_detail = '' WHERE id = ?").run(image.id);
  logAudit(req, 'cloud_image_patch_console', image.name, `storage=${storageId}; requestId=${req.requestId || ''}`);

  startBackgroundWork(async () => {
    const script = [
      'export LIBGUESTFS_BACKEND=direct',
      'command -v virt-customize >/dev/null 2>&1 || { echo HL_NO_LIBGUESTFS; exit 0; }',
      `test -f ${shq(imgPath)} || { echo HL_NO_IMAGE; exit 0; }`,
      `virt-customize -a ${shq(imgPath)} --run-command ${shq(OSC_GUEST_CMD)} 2>&1`,
    ].join('\n');
    let status = 'error';
    let detail = '';
    try {
      const [result] = await runNodeCommands(host, [script]);
      const out = result?.output || '';
      if (out.includes('HL_NO_LIBGUESTFS')) detail = 'libguestfs-tools is not installed on the host';
      else if (out.includes('HL_NO_IMAGE')) detail = `image file not found at ${imgPath}`;
      else if (out.includes('HL_PATCHED')) { status = 'patched'; detail = 'console OSC drop-in disabled'; }
      else if (out.includes('HL_ALREADY')) { status = 'patched'; detail = 'already patched'; }
      else if (out.includes('HL_NOT_NEEDED')) { status = 'patched'; detail = 'not needed — image has no systemd OSC drop-in'; }
      else detail = (out.trim().split('\n').pop() || `virt-customize exited with ${result?.code}`).slice(0, 300);
    } catch (err) {
      detail = String(err.message || 'patch failed').slice(0, 300);
    }
    db.prepare('UPDATE cloud_images SET console_patch_status = ?, console_patch_detail = ? WHERE id = ?')
      .run(status, detail, image.id);
  }, { kind: 'cloud-image-console-patch', id: image.id, requestId: req.requestId })
    .catch((err) => {
      db.prepare('UPDATE cloud_images SET console_patch_status = ?, console_patch_detail = ? WHERE id = ?')
        .run('error', sanitizeError(err.message), image.id);
    });

  res.json({ ok: true, status: 'patching' });
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
  // Rows downloaded before the switch to import content can't be used as an
  // import-from source — PVE rejects iso-content volumes as disk sources.
  if (image.volid.includes(':iso/')) {
    return res.status(400).json({ error: 'This image was stored as ISO content — remove it and add it again to re-download it as import content' });
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
    // The VMID is reserved for the duration of the create and handed back if it
    // fails, so a template build can't collide with a concurrent VM deploy.
    const { vmid, result: upid } = await withFreshVmid((id) => createVM(image.node, id, {
      name: String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || `cloud-template-${id}`,
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
    }));

    setImageStatus(image.id, 'templating', `Creating template "${name}" (VMID ${vmid})…`);
    logAudit(req, 'cloud_image_template', `${image.node}/${vmid}`, `image:${image.name} name:${name}`);

    startBackgroundWork(async () => {
      const result = await waitForTask(image.node, upid);
      if (!result.ok) {
        setImageStatus(image.id, 'ready', `Template creation failed (VMID ${vmid}): ${result.exitstatus}`);
        return;
      }
      const warnings = [];
      try {
        await resizeVMDisk(image.node, vmid, 'scsi0', `${baseDiskGb}G`);
      } catch (err) {
        warnings.push(`disk resize failed: ${sanitizeError(err.message)}`);
      }
      try {
        await convertToTemplate(image.node, vmid);
      } catch (err) {
        setImageStatus(image.id, 'ready', `VM ${vmid} imported but template conversion failed: ${sanitizeError(err.message)}`);
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
    }, { kind: 'cloud-image-template', id: image.id, requestId: req.requestId })
      .catch((err) => setImageStatus(image.id, 'ready', `Template creation failed: ${sanitizeError(err.message)}`));

    res.json({ vmid, status: 'templating' });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
