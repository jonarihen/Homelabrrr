import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { provisionedVms } from '../../db/schema/index.ts';
import { updateVMConfig, resizeVMDisk, startVM, getTaskStatus, getVMConfig } from '../../proxmox.ts';
import { log } from '../../utils/logger.ts';
import { notifyDeployment } from '../../services/deploymentNotification.ts';
import { computeCpuTopology } from '../../utils/cpuTopology.ts';
import { releaseWhenTaskStops } from '../../utils/capacity.ts';
import { syncVmTagsSafe } from '../../utils/vmTags.ts';
import { recordProvisionOwnership } from '../../services/provisionOwnership.ts';
import { provisionAllocation } from '../../utils/provisionIntent.ts';
import { setStep } from './shared.ts';

// ─── Background task polling ─────────────────────────────────────────────────

// Polls a PVE task to completion. Returns true on success. On failure/timeout
// it writes a terminal status + detail so the error is visible; on success it
// leaves the status untouched so the caller can finalize after its own
// post-task work (configure, resize, tags, start).
// Tasks whose monitoring gave up while Proxmox may still be running them.
const timedOutTasks = new Set<string>();

// Release a deploy's capacity reservation; if its task outlived the polling,
// hold it until Proxmox reports the task stopped (or the reservation TTL).
export function releaseCapacityAfter(node: string, upid: string | undefined, release: () => void) {
  if (!upid || !timedOutTasks.delete(upid)) return release();
  releaseWhenTaskStops(release, async () => (await getTaskStatus(node, upid)).status === 'stopped');
}

export async function pollTaskCompletion(provisionId: number, node: string, upid: string, { maxAttempts = 120 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const task = await getTaskStatus(node, upid);
      if (task.status === 'stopped') {
        if (task.exitstatus === 'OK') return true;
        await db.update(provisionedVms)
          .set({ status: 'error', status_detail: task.exitstatus || 'Task failed' })
          .where(eq(provisionedVms.id, provisionId));
        await notifyDeployment(provisionId);
        return false;
      }
    } catch { /* keep polling */ }
  }
  timedOutTasks.add(upid);
  await db.update(provisionedVms)
    .set({ status: 'needs_review', status_detail: 'Monitoring timed out — check the saved Proxmox task in Admin Operations before releasing or recovering the reservation' })
    .where(eq(provisionedVms.id, provisionId));
  await notifyDeployment(provisionId);
  return false;
}

export async function pollAndConfigure(provisionId: number, node: string, vmid: number, upid: string, opts: any) {
  // Wait for clone task to finish
  if (upid) {
    const ok = await pollTaskCompletion(provisionId, node, upid);
    await setStep(provisionId, 'clone', ok ? 'done' : 'error');
    if (!ok) return;
  } else {
    await setStep(provisionId, 'clone', 'done');
  }

  // Apply post-clone configuration
  await db.update(provisionedVms).set({ status: 'configuring', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
  await setStep(provisionId, 'configure', 'active');

  try {
    const config: any = {};
    const warnings = [];
    if (opts.cores) {
      const cpuLayout = await computeCpuTopology(node, opts.cores);
      config.cpu = 'host';
      config.sockets = cpuLayout.sockets;
      config.cores = cpuLayout.cores;
    }
    if (opts.memory) config.memory = parseInt(opts.memory);
    if (opts.description) {
      const [saved] = await db.select({ steps: provisionedVms.steps }).from(provisionedVms).where(eq(provisionedVms.id, provisionId)).limit(1);
      const marker = provisionAllocation(saved?.steps)?.marker;
      config.description = `${opts.description}${marker ? `\n${marker}` : ''}`;
    }

    // Cloud-init settings
    if (opts.cloudInit) {
      if (opts.ciUser) config.ciuser = opts.ciUser;
      if (opts.ciPassword) config.cipassword = opts.ciPassword;
      if (opts.sshKeys) config.sshkeys = encodeURIComponent(opts.sshKeys);
      if (opts.ipConfig) config.ipconfig0 = opts.ipConfig;
    }

    if (Object.keys(config).length > 0) {
      await updateVMConfig(node, vmid, config);
    }
    await setStep(provisionId, 'configure', 'done');

    // Resize disk if needed
    await setStep(provisionId, 'resize', 'active');
    if (opts.resizeDisk) {
      try {
        await resizeVMDisk(node, vmid, opts.resizeDisk, `${opts.diskGb}G`);
        await setStep(provisionId, 'resize', 'done');
      } catch (err) {
        await setStep(provisionId, 'resize', 'error', `resize to ${opts.diskGb}G failed`);
        throw err;
      }
    } else {
      await setStep(provisionId, 'resize', 'skipped');
    }

    // Apply VLAN tag to net0 if requested
    if (opts.vlanTag) {
      try {
        const vmCfg = await getVMConfig(node, vmid);
        const net0 = vmCfg.net0 || '';
        if (net0) {
          let parts = net0.split(',');
          parts = parts.filter((p: string) => !p.startsWith('tag='));
          parts.push(`tag=${opts.vlanTag}`);
          await updateVMConfig(node, vmid, { net0: parts.join(',') });
        }
      } catch (err: any) {
        log('error', 'provision_vlan_tag_failed', { provisionId, vmid, vlanTag: opts.vlanTag, error: err });
        throw err;
      }
    }

    await recordProvisionOwnership(provisionId);
    // Stamp PVE owner/VLAN tags now that assignment + net config are final
    await setStep(provisionId, 'tags', 'active');
    await syncVmTagsSafe(node, vmid);
    await setStep(provisionId, 'tags', 'done');

    if (warnings.length > 0) {
      await db.update(provisionedVms).set({ status: 'warning', status_detail: warnings.join('; ') }).where(eq(provisionedVms.id, provisionId));
    } else {
      await db.update(provisionedVms).set({ status: 'ready', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
    }
    await notifyDeployment(provisionId);
  } catch (err: any) {
    log('error', 'provision_post_clone_failed', { provisionId, vmid, error: err });
    await setStep(provisionId, 'configure', 'error', err.message);
    await db.update(provisionedVms)
      .set({ status: 'needs_review', status_detail: 'Post-clone configuration or ownership failed — verify credentials, VLAN and resources before assigning this VM' })
      .where(eq(provisionedVms.id, provisionId));
    await notifyDeployment(provisionId);
  }
}

// Background driver for the direct cloud-image flow: wait for the create+import
// task, grow the boot disk, apply cloud-init, stamp tags, optionally start.
export async function finishImageProvision(provisionId: number, node: string, vmid: number, upid: string, opts: any) {
  const ok = await pollTaskCompletion(provisionId, node, upid, { maxAttempts: 240 });
  await setStep(provisionId, 'create', ok ? 'done' : 'error');
  if (!ok) return; // status already error/timeout

  await db.update(provisionedVms).set({ status: 'configuring', status_detail: '' }).where(eq(provisionedVms.id, provisionId));
  const warnings = [];

  // Grow the imported boot disk
  await setStep(provisionId, 'resize', 'active');
  if (opts.diskGb) {
    try {
      await resizeVMDisk(node, vmid, 'scsi0', `${opts.diskGb}G`);
      await setStep(provisionId, 'resize', 'done');
    } catch {
      await setStep(provisionId, 'resize', 'error', `resize to ${opts.diskGb}G failed`);
      await db.update(provisionedVms).set({ status: 'needs_review', status_detail: 'Image disk resize failed — verify all disks before assignment' })
        .where(eq(provisionedVms.id, provisionId));
      return;
    }
  } else {
    await setStep(provisionId, 'resize', 'skipped');
  }

  // Apply cloud-init user / password / SSH keys / network
  await setStep(provisionId, 'cloudinit', 'active');
  try {
    const config: any = {};
    if (opts.ciUser) config.ciuser = opts.ciUser;
    if (opts.ciPassword) config.cipassword = opts.ciPassword;
    if (opts.sshKeys) config.sshkeys = encodeURIComponent(opts.sshKeys);
    config.ipconfig0 = opts.ipConfig || 'ip=dhcp';
    await updateVMConfig(node, vmid, config);
    await setStep(provisionId, 'cloudinit', 'done');
  } catch (err: any) {
    await setStep(provisionId, 'cloudinit', 'error', err.message);
    await db.update(provisionedVms).set({ status: 'needs_review', status_detail: 'Cloud-init configuration failed — complete credentials/network configuration before assignment' })
      .where(eq(provisionedVms.id, provisionId));
    return;
  }

  // Optionally start the VM
  if (opts.start) {
    await setStep(provisionId, 'start', 'active');
    try {
      await startVM(node, vmid);
      await setStep(provisionId, 'start', 'done');
    } catch (err: any) {
      await setStep(provisionId, 'start', 'error', err.message);
      await db.update(provisionedVms).set({ status: 'needs_review', status_detail: 'Image VM failed to start — verify start state before assignment' })
        .where(eq(provisionedVms.id, provisionId));
      return;
    }
  } else {
    await setStep(provisionId, 'start', 'done');
  }

  await recordProvisionOwnership(provisionId);
  await setStep(provisionId, 'tags', 'active');
  await syncVmTagsSafe(node, vmid);
  await setStep(provisionId, 'tags', 'done');
  await db.update(provisionedVms)
    .set({ status: warnings.length ? 'warning' : 'ready', status_detail: warnings.join('; ') })
    .where(eq(provisionedVms.id, provisionId));
  await notifyDeployment(provisionId);
}
