import { getStorageContent, getTaskStatus } from '../proxmox.ts';
import { sanitizeError } from './sanitize.ts';

export function storageSlug(name: unknown, fallback: string) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

export async function waitForStorageTask(
  node: string,
  upid: string,
  { attempts = 240, intervalMs = 5000 } = {},
) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const task: any = await getTaskStatus(node, upid);
      if (task.status === 'stopped') {
        return { ok: task.exitstatus === 'OK', exitstatus: task.exitstatus || '' };
      }
    } catch { /* keep polling */ }
  }
  return { ok: false, exitstatus: 'timeout' };
}

export async function awaitStorageDownload({
  node, storage, volid, upid, content, missingMessage,
}: {
  node: string;
  storage: string;
  volid: string;
  upid: string;
  content: string;
  missingMessage: string;
}): Promise<{ ok: true; size: number } | { ok: false; error: string }> {
  const result = await waitForStorageTask(node, upid);
  if (!result.ok) {
    return {
      ok: false,
      error: result.exitstatus === 'timeout'
        ? 'Timed out waiting for the download'
        : `Download failed: ${result.exitstatus}`,
    };
  }
  try {
    const volumes: any[] = await getStorageContent(node, storage, content) as any[];
    const vol = volumes.find((c: any) => c.volid === volid);
    if (!vol) return { ok: false, error: missingMessage };
    return { ok: true, size: vol.size || 0 };
  } catch (err: any) {
    return { ok: false, error: `Could not verify download: ${sanitizeError(err.message)}` };
  }
}
