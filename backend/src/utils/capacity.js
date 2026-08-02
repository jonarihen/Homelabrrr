import { getNodeStatus, getStorageStatus } from '../proxmox.js';
import { httpError } from './httpError.js';

const GB = 1024 ** 3;

const fmtGb = (bytes) => (bytes / GB).toFixed(1);

const validationError = (message) => httpError(400, message);

// Refuses a provision request that cannot fit on the target node right now:
// requested memory must fit in the node's free RAM and the requested disk in
// the storage's available space. Only capacity violations throw (tagged 400 —
// see utils/httpError.js); if Proxmox can't be queried the check is skipped
// rather than blocking provisioning on a monitoring hiccup — the clone/create call
// will surface real API problems itself.
export async function assertNodeCapacity(node, { memoryMb, diskGb, storage }) {
  let nodeStatus = null;
  try {
    nodeStatus = await getNodeStatus(node);
  } catch (err) {
    console.warn(`[capacity] could not read node status for ${node}: ${err.message}`);
  }

  if (nodeStatus && memoryMb) {
    const freeBytes = nodeStatus.memory?.free;
    const requestedBytes = memoryMb * 1024 * 1024;
    if (Number.isFinite(freeBytes) && requestedBytes > freeBytes) {
      throw validationError(
        `Not enough free memory on ${nodeStatus.nodeName}: requested ${fmtGb(requestedBytes)} GB, only ${fmtGb(freeBytes)} GB free`,
      );
    }
  }

  const requestedDiskGb = parseFloat(diskGb);
  if (storage && Number.isFinite(requestedDiskGb) && requestedDiskGb > 0) {
    let storageStatus = null;
    try {
      storageStatus = await getStorageStatus(node, storage);
    } catch (err) {
      console.warn(`[capacity] could not read storage "${storage}" on ${node}: ${err.message}`);
    }
    const availBytes = storageStatus?.avail;
    if (Number.isFinite(availBytes) && requestedDiskGb * GB > availBytes) {
      throw validationError(
        `Not enough space on storage "${storage}": requested ${requestedDiskGb} GB, only ${fmtGb(availBytes)} GB available`,
      );
    }
  }
}
