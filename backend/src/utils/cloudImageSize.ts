import { getHost } from '../proxmox.ts';
import { decodeNodeRef } from './nodeRef.ts';
import { hostHasSsh, runNodeCommands } from './pveSsh.ts';
import { httpError } from './httpError.ts';

export function imageVirtualSizeGb(output: string) {
  let info;
  try { info = JSON.parse(output); } catch { throw httpError(503, 'Cannot read the cloud image virtual disk size safely'); }
  const size = info?.['virtual-size'];
  if (!Number.isSafeInteger(size) || size <= 0) throw httpError(503, 'Cannot read the cloud image virtual disk size safely');
  return size / (1024 ** 3);
}

export async function getCloudImageVirtualSizeGb(image: { node: string; volid: string }, dependencies = { getHost, runNodeCommands }) {
  const { hostId } = decodeNodeRef(image.node);
  if (!hostId || !/^[a-zA-Z0-9._-]+:import\/[a-zA-Z0-9._-]+$/.test(image.volid)) {
    throw httpError(503, 'A host-specific cloud image volume is required for disk size verification');
  }
  const host = await dependencies.getHost(hostId);
  if (!hostHasSsh(host)) throw httpError(503, 'Configure Proxmox host SSH to verify cloud image virtual disk size before import');
  const results = await dependencies.runNodeCommands(host, [`qemu-img info --output=json -- "$(pvesm path '${image.volid}')"`]);
  if (results[0]?.code !== 0) throw httpError(503, 'Cannot read the cloud image virtual disk size safely');
  return imageVirtualSizeGb(results[0].output);
}
