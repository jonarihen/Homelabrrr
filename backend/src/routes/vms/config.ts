import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { sshKeys as sshKeysTable } from '../../db/schema/index.ts';
import { getVMStatus, vmAction, getVMConfig, updateVMConfig, getLXCConfig } from '../../proxmox.ts';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { checkVlanAssignment, parseVlanTag, parseNetInterface } from '../../utils/vlanAccess.ts';
import { derivePublicKey } from '../../utils/sshPublicKey.ts';
import { decryptSecret } from '../../utils/secrets.ts';
import { validatePassword } from '../../utils/validation.ts';
import { allowOp, serializeNodeIdentity } from './shared.ts';

const router = Router();

// ─── VM Config / VLAN ────────────────────────────────────────────────────────

router.get('/:node/:vmid/config', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.config'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const nodeIdentity = serializeNodeIdentity(node);
    try {
      res.json({ ...(await getVMConfig(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10) });
    } catch {
      res.json({ ...(await getLXCConfig(node, vmid)), ...nodeIdentity, vmid: parseInt(vmid, 10) });
    }
  } catch (err) {
    sendError(res, err);
  }
});

// ─── Cloud-init credential reset ─────────────────────────────────────────────

// Detect whether a qemu VM config exposes a cloud-init drive. PVE reports the
// drive back as e.g. "ide2: local-lvm:vm-100-cloudinit,media=cdrom"; the value
// always carries the "cloudinit" volume marker regardless of which bus it uses.
function hasCloudInitDrive(config = {}) {
  return Object.entries(config).some(([key, value]) => (
    /^(ide|sata|scsi|virtio)\d+$/.test(key)
    && typeof value === 'string'
    && value.includes('cloudinit')
  ));
}

// Loose OpenSSH public-key shape check (ssh-rsa / ssh-ed25519 / ecdsa-* / sk-*).
function looksLikeSshPublicKey(value = '') {
  return /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)\s+\S+/.test(String(value).trim());
}

// Availability probe for the frontend: reveal the reset action only for a
// strict owner (admins bypass) of a qemu VM that actually has a cloud-init
// drive. Keeps the feature hidden for non-owners (incl. see_all_vms and
// can_operate_all_vms) and for VMs without cloud-init.
router.get('/:node/:vmid/cloudinit', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.cloudinit.read'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    let config;
    try {
      config = await getVMConfig(node, vmid);
    } catch {
      // Not a qemu VM (or unreadable) — no cloud-init here.
      return res.json({ cloudInit: false, canReset: false, ciuser: '' });
    }
    const cloudInit = hasCloudInitDrive(config);
    const owns = await allowOp(req, node, vmid, 'vm.cloudinit.credentials');
    res.json({
      cloudInit,
      canReset: cloudInit && owns,
      ciuser: typeof config.ciuser === 'string' ? config.ciuser : '',
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:node/:vmid/cloudinit-credentials', async (req, res) => {
  const { node, vmid } = req.params;
  const { password, sshKeyId, sshKey, reboot } = req.body || {};

  // Strict ownership only — no fleet-wide permission grants credential resets,
  // mirroring VM deletion. Admins bypass.
  if (!(await allowOp(req, node, vmid, 'vm.cloudinit.credentials'))) {
    return res.status(403).json({ error: 'You can only reset credentials for VMs assigned to you' });
  }

  // Must be a qemu VM with a cloud-init drive, otherwise hide the feature (404).
  let config;
  try {
    config = await getVMConfig(node, vmid);
  } catch {
    return res.status(404).json({ error: 'Cloud-init is not available for this VM' });
  }
  if (!hasCloudInitDrive(config)) {
    return res.status(404).json({ error: 'This VM does not have a cloud-init drive' });
  }

  // Resolve the SSH public key — either from one of the user's stored keys or a
  // pasted value. Only public keys are ever touched here; nothing is stored.
  let sshKeys = '';
  if (sshKeyId) {
    const [row] = await db
      .select({ public_key: sshKeysTable.public_key, private_key: sshKeysTable.private_key })
      .from(sshKeysTable)
      .where(and(eq(sshKeysTable.id, Number.parseInt(sshKeyId, 10)), eq(sshKeysTable.user_id, req.session.userId)))
      .limit(1);
    if (!row) return res.status(400).json({ error: 'Selected SSH key was not found' });
    let publicKey = (row.public_key || '').trim();
    if (!publicKey) {
      // Backfill from the private half — same derivation the SSH key list uses.
      try { publicKey = derivePublicKey(decryptSecret(row.private_key)).trim(); } catch { publicKey = ''; }
    }
    if (!publicKey) {
      return res.status(400).json({ error: 'Could not derive a public key from that stored key — re-add it with its public key.' });
    }
    sshKeys = publicKey;
  } else if (typeof sshKey === 'string' && sshKey.trim()) {
    sshKeys = sshKey.trim();
    if (!looksLikeSshPublicKey(sshKeys)) {
      return res.status(400).json({ error: 'That does not look like an OpenSSH public key' });
    }
  }

  const newPassword = typeof password === 'string' ? password : '';
  if (!newPassword && !sshKeys) {
    return res.status(400).json({ error: 'Provide a new password and/or an SSH public key' });
  }
  if (newPassword) {
    try { validatePassword(newPassword); }
    catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  }

  try {
    // Update cloud-init config. Setting cipassword/sshkeys marks the cloud-init
    // drive for regeneration; PVE rebuilds it and the guest re-applies on the
    // next boot — hence the reboot requirement. URL-encode sshkeys exactly like
    // the from-image provisioning flow does (a PVE quirk).
    const updates = {};
    if (newPassword) updates.cipassword = newPassword;
    if (sshKeys) updates.sshkeys = encodeURIComponent(sshKeys);
    await updateVMConfig(node, vmid, updates);

    // Best-effort inline reboot so the change takes effect immediately: reboot a
    // running VM, or start a stopped one (a stopped guest can't be rebooted).
    let rebooted = false;
    if (reboot) {
      try {
        const status = await getVMStatus(node, vmid);
        if (status?.status === 'running') {
          await vmAction(node, vmid, 'reboot');
        } else {
          await vmAction(node, vmid, 'start');
        }
        rebooted = true;
      } catch (err) {
        console.warn(`[cloudinit-creds] reboot for ${node}/${vmid} failed: ${err.message}`);
      }
    }

    // Audit the event only — never the password or the key material.
    const changed = [newPassword ? 'password' : null, sshKeys ? 'ssh-key' : null].filter(Boolean).join('+');
    await logAudit(req, 'vm_cloudinit_credentials_reset', `${node}/${vmid}`, `${changed}${rebooted ? ';rebooted' : ''}`);

    res.json({
      ok: true,
      changedPassword: !!newPassword,
      changedSshKey: !!sshKeys,
      rebooted,
      rebootRequired: !rebooted,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:node/:vmid/vlan', async (req, res) => {
  const { node, vmid } = req.params;
  const { netInterface: rawNetInterface, vlanTag } = req.body;

  if (!(await allowOp(req, node, vmid, 'vm.vlan'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // A NIC config is a comma-delimited property list, so both the key and the
  // tag have to be normalized before they are written — and the *normalized*
  // tag is what gets configured below, so authorization can never approve one
  // value while a different one reaches Proxmox (utils/vlanAccess.ts).
  const netInterface = parseNetInterface(rawNetInterface);
  if (!netInterface) return res.status(400).json({ error: 'Invalid network interface' });

  const parsedTag = parseVlanTag(vlanTag);
  if ('invalid' in parsedTag) return res.status(400).json({ error: 'Invalid VLAN tag' });

  // Authorize the target VLAN. Non-admins must move the VM onto a VLAN assigned
  // to them; setting it untagged (removing the tag) drops the VM onto the
  // native network and is admin-only (utils/vlanAccess.ts).
  const vlanErr = await checkVlanAssignment(db, { userId: req.session.userId, isAdmin: req.session.isAdmin, vlanTag });
  if (vlanErr) return res.status(vlanErr.status).json({ error: vlanErr.error });

  try {
    const config = await getVMConfig(node, vmid);
    const current = config[netInterface];
    if (!current) {
      return res.status(400).json({ error: `Interface ${netInterface} not found on this VM` });
    }

    // Parse "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=100,firewall=1" style string
    let parts = current.split(',');
    if ('untagged' in parsedTag) {
      parts = parts.filter(p => !p.startsWith('tag='));
    } else if (parts.some(p => p.startsWith('tag='))) {
      parts = parts.map(p => p.startsWith('tag=') ? `tag=${parsedTag.tag}` : p);
    } else {
      parts.push(`tag=${parsedTag.tag}`);
    }

    await updateVMConfig(node, vmid, { [netInterface]: parts.join(',') });
    const auditTag = 'untagged' in parsedTag ? 'none' : parsedTag.tag;
    await logAudit(req, 'vlan_change', `${node}/${vmid}`, `${netInterface}=tag:${auditTag}`);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
