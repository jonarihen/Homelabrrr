import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { getTaskStatus, getStorageContent } from '../proxmox.ts';
import { sanitizeError } from './sanitize.ts';
import { startBackgroundWork } from '../services/backgroundWork.ts';

export async function waitForDownloadTask(node: string, upid: string, { attempts = 240, intervalMs = 5000 } = {}) {
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

/**
 * Poll a download task and verify the resulting volume exists, updating the
 * caller through callbacks. Shared by the cloud-image and ISO download routes.
 */
export async function trackDownloadTask({
  node,
  upid,
  storage,
  contentKind,
  volid,
  artifact,
  setError,
  onReady,
}: {
  node: string;
  upid: string;
  storage: string;
  contentKind: string;
  volid: string;
  artifact: string;
  setError: (detail: string) => Promise<void>;
  onReady: (size: number) => Promise<void>;
}) {
  const result = await waitForDownloadTask(node, upid);
  if (!result.ok) {
    await setError(result.exitstatus === 'timeout'
      ? 'Timed out waiting for the download'
      : `Download failed: ${result.exitstatus}`);
    return;
  }
  try {
    const content = await getStorageContent(node, storage, contentKind);
    const vol = content.find((c: any) => c.volid === volid);
    if (!vol) {
      await setError(`Download finished but the ${artifact} was not found on the storage`);
      return;
    }
    await onReady(vol.size || 0);
  } catch (err: any) {
    await setError(`Could not verify download: ${sanitizeError(err.message)}`);
  }
}

/**
 * Kick off the background download tracking for a download-catalog row,
 * folding the row status updates and the standard error fallback into one
 * call site per route.
 */
export function startDownloadTracking({ kind, id, requestId, table, ...track }: {
  kind: string;
  id: number;
  requestId: string;
  table: any;
  node: string;
  upid: string;
  storage: string;
  contentKind: string;
  volid: string;
  artifact: string;
}) {
  const setError = (detail: string) =>
    db.update(table).set({ status: 'error', status_detail: detail }).where(eq(table.id, id));
  const onReady = (size: number) =>
    db.update(table).set({ status: 'ready', status_detail: '', size }).where(eq(table.id, id));

  startBackgroundWork(async () => {
    await trackDownloadTask({ ...track, setError, onReady });
  }, { kind, id, requestId })
    .catch((err: any) => { setError(sanitizeError(err.message)).catch(() => {}); });
}
