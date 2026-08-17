import { getStorageDefs, getHost, getHosts, getNodes } from '../proxmox.ts';
import { decodeNodeRef, encodeNodeRef } from './nodeRef.ts';
import { sharedStorageKey } from './sharedStorage.ts';

// A cloud image row lives on one host, but if its storage is a shared backend
// (same NFS/CIFS mounted on other registered hosts) the exact same import-from
// volume is reachable from those hosts too — so the image can be deployed from
// any of them, not just the one it was downloaded on. Returns every usable
// host: always the image's own host, plus shared-storage peers. Each target
// carries the storage id and volid as addressed on THAT host (identical when
// the shared storage shares its id, remapped otherwise). Best effort — an
// unreachable peer is simply skipped.
export async function imageDeployTargets(image) {
  const { hostId: ownHostId, nodeName: ownNode } = decodeNodeRef(image.node);
  const storageId = image.volid.split(':')[0];
  const volPath = image.volid.slice(storageId.length + 1);
  const targets = [{ hostId: ownHostId, node: ownNode, nodeRef: image.node, storage: storageId, volid: image.volid }];
  try {
    const ownHost = getHost(ownHostId);
    if (!ownHost) return targets;
    const ownDefs = await getStorageDefs(ownHost);
    const key = sharedStorageKey((ownDefs || []).find((d) => d.storage === storageId));
    if (!key) return targets; // local storage — only usable on its own host

    const nodeByHost = new Map();
    for (const n of await getNodes()) if (!nodeByHost.has(n.hostId)) nodeByHost.set(n.hostId, n.node);

    for (const h of getHosts()) {
      if (h.id === ownHostId) continue;
      const nodeName = nodeByHost.get(h.id);
      if (!nodeName) continue;
      try {
        const defs = await getStorageDefs(h);
        const match = (defs || []).find((d) => sharedStorageKey(d) === key && String(d.content || '').includes('import'));
        if (!match) continue;
        const volid = match.storage === storageId ? image.volid : `${match.storage}:${volPath}`;
        targets.push({ hostId: h.id, node: nodeName, nodeRef: encodeNodeRef(h.id, nodeName), storage: match.storage, volid });
      } catch { /* peer unreachable — skip */ }
    }
  } catch { /* best effort — fall back to own host only */ }
  return targets;
}

// The default target pool for deploying this image on a given host: the
// per-host map wins, then the legacy single default_storage, else null (the
// caller auto-picks). `image.default_storage_map` is the JSON string column.
export function defaultStorageForHost(image, hostId) {
  let map = {};
  try { map = image.default_storage_map ? JSON.parse(image.default_storage_map) : {}; } catch { map = {}; }
  return map[String(hostId)] || map[hostId] || image.default_storage || null;
}
