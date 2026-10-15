import { getHost, hostGet } from '../proxmox.ts';
import { decodeNodeRef, isValidNodeName } from './nodeRef.ts';
import { httpError, tagStatus } from './httpError.ts';

export function imageVirtualSizeGb(info: unknown) {
  const size = info && typeof info === 'object' && 'size' in info ? info.size : null;
  const format = info && typeof info === 'object' && 'format' in info ? info.format : null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || typeof format !== 'string' || !['raw', 'qcow2', 'vmdk'].includes(format)) {
    throw httpError(503, 'Cannot read the cloud image virtual disk size safely');
  }
  return size / (1024 ** 3);
}

export async function getCloudImageVirtualSizeGb(image: { node: string; volid: string }, dependencies = { getHost, hostGet }) {
  const { hostId, nodeName } = decodeNodeRef(image.node);
  const volume = /^([a-zA-Z0-9][a-zA-Z0-9._-]*):import\/[a-zA-Z0-9._-]+$/.exec(image.volid);
  if (!hostId || !isValidNodeName(nodeName) || !volume) {
    throw httpError(503, 'A host-specific cloud image volume is required for disk size verification');
  }
  const host = await dependencies.getHost(hostId);
  if (!host) throw httpError(503, 'The Proxmox host for this cloud image is not configured');
  let info;
  try {
    info = await dependencies.hostGet(host, `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(volume[1])}/content/${encodeURIComponent(image.volid)}`);
  } catch (err) {
    throw tagStatus(err, 503);
  }
  return imageVirtualSizeGb(info);
}
