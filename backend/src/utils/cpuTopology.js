import { getNodeCpuInfo } from '../proxmox.js';

/**
 * Compute VM CPU topology to match the physical host layout.
 * Always spreads cores across sockets evenly, capped at the host's cores-per-socket.
 * Returns { sockets, cores, totalVcpus, maxCores } for the Proxmox VM config.
 * Throws if the request exceeds the node's physical cores.
 */
export async function computeCpuTopology(node, requestedCores) {
  const vcpus = parseInt(requestedCores) || 2;
  try {
    const cpuInfo = await getNodeCpuInfo(node);
    const physSockets = Math.max(1, cpuInfo.sockets || 1);
    const physCoresPerSocket = Math.max(1, cpuInfo.coresPerSocket || 1);
    const maxCores = physSockets * physCoresPerSocket;
    if (vcpus > maxCores) {
      const err = new Error(`Requested ${vcpus} cores exceeds this node's ${maxCores} physical cores (${physSockets}\u00d7${physCoresPerSocket})`);
      err.status = 400;
      throw err;
    }
    const validSockets = [];
    for (let sockets = 1; sockets <= Math.min(physSockets, vcpus); sockets += 1) {
      if (vcpus % sockets !== 0) continue;
      const coresPerSocket = vcpus / sockets;
      if (coresPerSocket <= physCoresPerSocket) {
        validSockets.push(sockets);
      }
    }
    const sockets = validSockets.length > 0 ? Math.max(...validSockets) : 1;
    const coresPerSocket = Math.ceil(vcpus / sockets);
    return { sockets, cores: coresPerSocket, totalVcpus: sockets * coresPerSocket, maxCores };
  } catch (err) {
    if (err.status) throw err; // re-throw validation errors
    return { sockets: 1, cores: vcpus, totalVcpus: vcpus, maxCores: null };
  }
}
