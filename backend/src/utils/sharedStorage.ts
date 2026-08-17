// A storage is "shared" between two separate (non-clustered) Proxmox hosts
// when both mount the same remote filesystem: NFS (server + export) or CIFS
// (server + share). The storage ID may differ per host, so identity is the
// backend tuple, not the name. A volume on such storage is reachable — by the
// same on-disk path — from every host that mounts it, which is what lets a
// cloud image on shared storage be deployed from any of those hosts and lets a
// migration adopt shared disks instead of copying them.
export function sharedStorageKey(def) {
  if (!def || def.disable) return null;
  if (def.type === 'nfs' && def.server && def.export) return `nfs:${def.server}:${def.export}`;
  if (def.type === 'cifs' && def.server && def.share) return `cifs:${def.server}:${def.share}`;
  return null;
}
