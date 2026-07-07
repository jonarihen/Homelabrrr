import https from 'https';
import db from './db.js';
import { decryptSecret } from './utils/secrets.js';
import { decodeNodeRef, encodeNodeRef, isValidNodeName } from './utils/nodeRef.js';

const ALLOW_INSECURE_UPSTREAM_TLS = process.env.ALLOW_INSECURE_UPSTREAM_TLS === 'true';

function assertSecureTls(host, label = 'Proxmox host') {
  if (host.verify_tls === 0 && !ALLOW_INSECURE_UPSTREAM_TLS) {
    throw new Error(`${label} TLS verification is disabled. Re-enable TLS verification or set ALLOW_INSECURE_UPSTREAM_TLS=true as a temporary exception.`);
  }
}

function agentForHost(host) {
  assertSecureTls(host);
  return new https.Agent({ rejectUnauthorized: host.verify_tls !== 0 });
}

function getHostById(hostId) {
  const host = db.prepare('SELECT * FROM pve_hosts WHERE id = ?').get(hostId);
  if (!host) {
    throw new Error(`Configured Proxmox host ${hostId} was not found`);
  }
  return host;
}

// ── Per-host API request ─────────────────────────────────────────────────────

function makeRequest(host, method, path, body) {
  const url = new URL(`https://${host.host}:${host.port}/api2/json${path}`);
  const authHeader = `PVEAPIToken=${host.token_id}=${decryptSecret(host.token_secret)}`;
  const payload = body && method !== 'DELETE' ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      agent: agentForHost(host),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Proxmox ${method} ${path} → ${res.statusCode}: ${text}`));
          return;
        }
        try { resolve(JSON.parse(text).data); }
        catch { resolve(text); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Proxmox request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

export const hostDelete = (host, path) => makeRequest(host, 'DELETE', path);

// ── Host helpers ─────────────────────────────────────────────────────────────

export function getHosts() {
  return db.prepare('SELECT * FROM pve_hosts ORDER BY name').all();
}

export function getHost(id) {
  return db.prepare('SELECT * FROM pve_hosts WHERE id = ?').get(id);
}

// Get first host (backwards compat for single-host usage)
function defaultHost() {
  const host = db.prepare('SELECT * FROM pve_hosts ORDER BY id LIMIT 1').get();
  if (!host) throw new Error('No PVE hosts configured');
  return host;
}

async function findHostsForNodeName(nodeName) {
  const hosts = getHosts();
  const matches = [];
  for (const h of hosts) {
    try {
      const nodes = await makeRequest(h, 'GET', '/nodes');
      if (nodes.some(n => n.node === nodeName)) matches.push(h);
    } catch { /* skip unreachable host */ }
  }
  return matches;
}

async function hostForNode(nodeRef, opts = {}) {
  const { vmid = null } = opts;
  const { hostId, nodeName } = decodeNodeRef(nodeRef);
  if (!nodeName) throw new Error('Node is required');
  if (!isValidNodeName(nodeName)) throw new Error('Invalid node name');

  if (hostId) return getHostById(hostId);

  const matches = await findHostsForNodeName(nodeName);
  if (matches.length === 1) return matches[0];

  if (matches.length > 1 && vmid !== null && vmid !== undefined) {
    const vmMatches = [];
    for (const h of matches) {
      try {
        const resources = await makeRequest(h, 'GET', '/cluster/resources?type=vm');
        if (resources.some(r => r.node === nodeName && Number.parseInt(r.vmid, 10) === Number.parseInt(vmid, 10))) {
          vmMatches.push(h);
        }
      } catch { /* skip unreachable host */ }
    }
    if (vmMatches.length === 1) return vmMatches[0];
    if (vmMatches.length > 1) {
      throw new Error(`VM ${vmid} on node ${nodeName} exists on multiple configured hosts. Use a host-specific node reference.`);
    }
  }

  if (matches.length === 0) {
    const hosts = getHosts();
    if (hosts.length === 1) return hosts[0];
    throw new Error(`Node ${nodeName} was not found on any configured Proxmox host`);
  }

  throw new Error(`Node ${nodeName} exists on multiple configured Proxmox hosts. Use a host-specific node reference.`);
}

async function resolveNode(nodeRef, opts = {}) {
  const { nodeName } = decodeNodeRef(nodeRef);
  const host = await hostForNode(nodeRef, opts);
  return { host, nodeName };
}

// ── Proxmox API wrappers ─────────────────────────────────────────────────────

export const proxmoxGet  = (path)       => makeRequest(defaultHost(), 'GET', path);
export const proxmoxPost = (path, body) => makeRequest(defaultHost(), 'POST', path, body ?? {});
export const proxmoxPut  = (path, body) => makeRequest(defaultHost(), 'PUT', path, body ?? {});

// Host-aware variants
export const hostGet  = (host, path)       => makeRequest(host, 'GET', path);
export const hostPost = (host, path, body) => makeRequest(host, 'POST', path, body ?? {});
export const hostPut  = (host, path, body) => makeRequest(host, 'PUT', path, body ?? {});

// Short-lived cache for getAllVMs — avoids hammering Proxmox on every poll
let _vmCache = { data: null, expires: 0 };
const VM_CACHE_TTL = 5000; // 5 seconds
const _vmConfigCache = new Map();
const VM_CONFIG_CACHE_TTL = 5000;

function vmConfigCacheKey(nodeRef, vmid, type = 'qemu') {
  const { hostId, nodeName } = decodeNodeRef(nodeRef);
  return `${type}:${hostId || 'auto'}:${nodeName}:${Number.parseInt(vmid, 10)}`;
}

function getCachedVmConfig(nodeRef, vmid, type = 'qemu') {
  const key = vmConfigCacheKey(nodeRef, vmid, type);
  const entry = _vmConfigCache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) _vmConfigCache.delete(key);
  return null;
}

function setCachedVmConfig(nodeRef, vmid, data, type = 'qemu') {
  _vmConfigCache.set(vmConfigCacheKey(nodeRef, vmid, type), {
    data,
    expires: Date.now() + VM_CONFIG_CACHE_TTL,
  });
}

function clearCachedVmConfig(nodeRef, vmid, type = 'qemu') {
  _vmConfigCache.delete(vmConfigCacheKey(nodeRef, vmid, type));
}

export async function getAllVMs() {
  const now = Date.now();
  if (_vmCache.data && now < _vmCache.expires) return _vmCache.data;

  const hosts = getHosts();
  const allVms = [];
  for (const h of hosts) {
    try {
      const resources = await makeRequest(h, 'GET', '/cluster/resources?type=vm');
      allVms.push(...resources
        .filter(r => r.type === 'qemu' || r.type === 'lxc')
        .map(r => ({
          ...r,
          hostId: h.id,
          hostName: h.name,
          nodeRef: encodeNodeRef(h.id, r.node),
        })));
    } catch (err) {
      console.warn(`Failed to fetch VMs from ${h.name} (${h.host}): ${err.message}`);
    }
  }
  _vmCache = { data: allVms, expires: now + VM_CACHE_TTL };
  return allVms;
}

export async function getVMStatus(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/status/current`);
}

export async function vmAction(node, vmid, action) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/status/${action}`, {});
}

export async function getVNCTicket(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/vncproxy`, { websocket: 1 });
}

export async function getVMConfig(node, vmid) {
  const cached = getCachedVmConfig(node, vmid, 'qemu');
  if (cached) return cached;
  const { host, nodeName } = await resolveNode(node, { vmid });
  const config = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/config`);
  setCachedVmConfig(node, vmid, config, 'qemu');
  return config;
}

export async function updateVMConfig(node, vmid, config) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  clearCachedVmConfig(node, vmid, 'qemu');
  return makeRequest(host, 'PUT', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/config`, config);
}

export async function getLXCStatus(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/status/current`);
}

export async function lxcAction(node, vmid, action) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/status/${action}`, {});
}

export async function getLXCConfig(node, vmid) {
  const cached = getCachedVmConfig(node, vmid, 'lxc');
  if (cached) return cached;
  const { host, nodeName } = await resolveNode(node, { vmid });
  const config = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/config`);
  setCachedVmConfig(node, vmid, config, 'lxc');
  return config;
}

export async function updateLXCConfig(node, vmid, config) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  clearCachedVmConfig(node, vmid, 'lxc');
  return makeRequest(host, 'PUT', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/config`, config);
}

export async function getLXCRRD(node, vmid, timeframe = 'hour') {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/rrddata?timeframe=${encodeURIComponent(timeframe)}`);
}

export async function getLXCVNCTicket(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/vncproxy`, { websocket: 1 });
}

export async function getVMRRD(node, vmid, type = 'qemu', timeframe = 'hour') {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/${type}/${vmid}/rrddata?timeframe=${encodeURIComponent(timeframe)}`);
}

// ── Node CPU topology ────────────────────────────────────────────────────────

export async function getNodeCpuInfo(node) {
  const { host, nodeName } = await resolveNode(node);
  const status = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/status`);
  const info = status.cpuinfo || {};
  return {
    sockets: info.sockets || 1,
    coresPerSocket: info.cores || 1,
    threads: info.cpus || 1,
    model: info.model || '',
  };
}

export async function getNodeStatus(node) {
  const { host, nodeName } = await resolveNode(node);
  const status = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/status`);
  return { ...status, nodeName };
}

export async function getStorageStatus(node, storage) {
  const { host, nodeName } = await resolveNode(node);
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/status`);
}

// ── Host status check ────────────────────────────────────────────────────────

export async function getHostStatus(host) {
  try {
    const [version, nodes] = await Promise.all([
      makeRequest(host, 'GET', '/version'),
      makeRequest(host, 'GET', '/nodes'),
    ]);
    const vms = await makeRequest(host, 'GET', '/cluster/resources?type=vm');
    return {
      online: true,
      version: version.version,
      release: version.release,
      nodes: nodes.map(n => ({ node: n.node, status: n.status, cpu: n.cpu, maxcpu: n.maxcpu, mem: n.mem, maxmem: n.maxmem, uptime: n.uptime })),
      vmCount: vms.filter(v => v.type === 'qemu').length,
      runningVms: vms.filter(v => v.type === 'qemu' && v.status === 'running').length,
    };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Provisioning helpers ─────────────────────────────────────────────────────

export async function getNextVmid() {
  const hosts = getHosts();
  // Collect all used VMIDs across every connected host so IDs are globally unique
  const usedIds = new Set();
  const failedHosts = [];
  for (const h of hosts) {
    try {
      const resources = await makeRequest(h, 'GET', '/cluster/resources?type=vm');
      for (const r of resources) usedIds.add(r.vmid);
    } catch {
      failedHosts.push(h.name || h.host);
    }
  }
  if (failedHosts.length > 0) {
    throw new Error(`Cannot allocate a globally unique VMID while these Proxmox hosts are unreachable: ${failedHosts.join(', ')}`);
  }
  if (usedIds.size === 0) {
    // No VMs anywhere — ask any reachable host for its default next ID
    for (const h of hosts) {
      try { return await makeRequest(h, 'GET', '/cluster/nextid'); } catch { /* next */ }
    }
  }
  // Find the lowest free VMID starting at 100 (Proxmox minimum)
  let vmid = 100;
  while (usedIds.has(vmid)) vmid++;
  return vmid;
}

export async function cloneVM(node, templateVmid, newVmid, name, opts = {}) {
  const { host, nodeName } = await resolveNode(node, { vmid: templateVmid });
  const body = {
    newid: newVmid,
    name,
    full: 1,  // full clone (not linked)
    ...(opts.target && { target: opts.target }),
    ...(opts.storage && { storage: opts.storage }),
    ...(opts.description && { description: opts.description }),
  };
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/qemu/${templateVmid}/clone`, body);
}

export async function createVM(node, vmid, config) {
  const { host, nodeName } = await resolveNode(node);
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/qemu`, { vmid, ...config });
}

export async function resizeVMDisk(node, vmid, disk, size) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'PUT', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/resize`, { disk, size });
}

export async function startVM(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/status/start`, {});
}

export async function getStorages(node) {
  const { host, nodeName } = await resolveNode(node);
  const storages = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage`);
  return storages.filter(s => s.active && s.enabled);
}

export async function getISOImages(node, storage) {
  const { host, nodeName } = await resolveNode(node);
  const content = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/content?content=iso`);
  return content || [];
}

// Ask PVE to download a file from a URL into a storage as `import` content —
// the only content type (besides images) that qemu's import-from accepts as a
// disk source on PVE 9. The storage must have the Import content type
// enabled. Returns the download task UPID.
export async function downloadUrlToStorage(node, storage, url, filename, checksum, checksumAlgorithm) {
  const { host, nodeName } = await resolveNode(node);
  const body = { content: 'import', url, filename };
  if (checksum) {
    body.checksum = checksum;
    body['checksum-algorithm'] = checksumAlgorithm || 'sha256';
  }
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/download-url`, body);
}

export async function getStorageContent(node, storage, content) {
  const { host, nodeName } = await resolveNode(node);
  const list = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/content?content=${encodeURIComponent(content)}`);
  return list || [];
}

export async function deleteVolume(node, volid) {
  const { host, nodeName } = await resolveNode(node);
  const storage = String(volid).split(':')[0];
  return makeRequest(host, 'DELETE', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`);
}

export async function convertToTemplate(node, vmid) {
  const { host, nodeName } = await resolveNode(node);
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/template`, {});
}

export async function getNetworks(node) {
  const { host, nodeName } = await resolveNode(node);
  const nets = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/network`);
  return (nets || []).filter(n => n.type === 'bridge');
}

export async function getNodes() {
  const hosts = getHosts();
  const allNodes = [];
  for (const h of hosts) {
    try {
      const nodes = await makeRequest(h, 'GET', '/nodes');
      allNodes.push(...nodes.map(n => ({ ...n, hostId: h.id, hostName: h.name, nodeRef: encodeNodeRef(h.id, n.node) })));
    } catch { /* skip */ }
  }
  return allNodes;
}

export async function getTaskStatus(node, upid) {
  const { host, nodeName } = await resolveNode(node);
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/tasks/${encodeURIComponent(upid)}/status`);
}

// ── VM deletion ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitForGuestStopped(host, nodeName, vmtype, vmid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/status/current`);
    if (status.status === 'stopped') return;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${vmtype}/${vmid} to stop`);
}

async function waitForTaskCompletion(host, nodeName, upid, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/tasks/${encodeURIComponent(upid)}/status`);
    if (task.status === 'stopped') {
      if (task.exitstatus !== 'OK') {
        throw new Error(`Proxmox task failed: ${task.exitstatus}`);
      }
      return;
    }
    await sleep(2000);
  }
  throw new Error('Timed out waiting for Proxmox task to complete');
}

export async function deleteVM(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });

  let vmtype = 'qemu';
  let status;
  try {
    status = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/status/current`);
  } catch {
    status = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/status/current`);
    vmtype = 'lxc';
  }

  // Proxmox refuses to destroy a running guest — force-stop it first
  if (status.status === 'running') {
    await makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/status/stop`, {});
    await waitForGuestStopped(host, nodeName, vmtype, vmid);
  }

  // purge removes the guest from backup jobs, HA and replication config
  const upid = await makeRequest(host, 'DELETE', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}?purge=1&destroy-unreferenced-disks=1`);
  await waitForTaskCompletion(host, nodeName, upid);

  clearCachedVmConfig(node, vmid, vmtype);
  _vmCache = { data: null, expires: 0 };
  return { vmtype };
}

// ── Snapshot helpers ─────────────────────────────────────────────────────────

export async function getSnapshots(node, vmid, vmtype = 'qemu') {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/snapshot`);
}

export async function createSnapshot(node, vmid, vmtype = 'qemu', name, description = '', vmstate = false) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  const body = { snapname: name, ...(description && { description }), ...(vmtype === 'qemu' && { vmstate: vmstate ? 1 : 0 }) };
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/snapshot`, body);
}

export async function deleteSnapshot(node, vmid, vmtype = 'qemu', snapname) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'DELETE', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/snapshot/${encodeURIComponent(snapname)}`);
}

export async function rollbackSnapshot(node, vmid, vmtype = 'qemu', snapname) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`, {});
}

// ── Backup helpers ──────────────────────────────────────────────────────────

export async function getVMBackups(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  // List all storages, then check each backup-capable one for this VM's backups
  const storages = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage`);
  const backupStorages = storages.filter(s => s.active && s.enabled && s.content?.includes('backup'));
  const allBackups = [];
  for (const s of backupStorages) {
    try {
      const content = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(s.storage)}/content?content=backup&vmid=${encodeURIComponent(vmid)}`);
      if (content) allBackups.push(...content.map(b => ({ ...b, storage: s.storage })));
    } catch { /* skip */ }
  }
  // Sort newest first
  allBackups.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
  return allBackups;
}

export async function createVMBackup(node, vmid, opts = {}) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  const body = {
    vmid: parseInt(vmid),
    mode: opts.mode || 'snapshot',
    compress: opts.compress || 'zstd',
    ...(opts.storage && { storage: opts.storage }),
    ...(opts.notes && { 'notes-template': opts.notes }),
  };
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/vzdump`, body);
}

export async function restoreVMBackup(node, vmid, archive, storage, vmtype = 'qemu') {
  const { host, nodeName } = await resolveNode(node, { vmid });
  const body = {
    vmid: parseInt(vmid),
    archive,
    force: 1,
    ...(storage && { storage }),
  };
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}`, body);
}

export async function deleteVMBackup(node, storage, volid) {
  const { host, nodeName } = await resolveNode(node);
  return makeRequest(host, 'DELETE', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`);
}

export async function getBackupStorages(node) {
  const { host, nodeName } = await resolveNode(node);
  const storages = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage`);
  return storages.filter(s => s.active && s.enabled && s.content?.includes('backup'));
}

// ── File-level restore from backups ─────────────────────────────────────────

export async function listBackupFiles(node, storage, volid, filepath = '/') {
  const { host, nodeName } = await resolveNode(node);
  const params = new URLSearchParams({ volume: volid, filepath });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/file-restore/list?${params}`);
}

export async function downloadBackupFile(node, storage, volid, filepath) {
  const { host, nodeName } = await resolveNode(node);
  const params = new URLSearchParams({ volume: volid, filepath });
  const baseUrl = `https://${host.host}:${host.port}/api2/json`;
  const authHeader = `PVEAPIToken=${host.token_id}=${decryptSecret(host.token_secret)}`;
  const url = `${baseUrl}/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/file-restore/download?${params}`;

  // Use Node https module for proper TLS handling (fetch doesn't support agent)
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: authHeader },
      agent: agentForHost(host),
    }, (res) => {
      if (res.statusCode >= 400) {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => reject(new Error(`Download failed: ${res.statusCode} ${body}`)));
        return;
      }
      resolve({ stream: res, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Exports for VNC WS proxy (needs raw host/port/token for node) ────────────

export async function getHostForNode(nodeName) {
  const host = await hostForNode(nodeName);
  assertSecureTls(host, `Proxmox node host ${host.name || host.host}`);
  return {
    host: host.host,
    port: host.port,
    tokenId: host.token_id,
    tokenSecret: decryptSecret(host.token_secret),
    verifyTls: host.verify_tls !== 0,
  };
}
