import https from 'https';
import tls from 'tls';
import db from './db.js';
import { decryptSecret } from './utils/secrets.js';
import { decodeNodeRef, encodeNodeRef, isValidNodeName } from './utils/nodeRef.js';
import { pickVmid, isVmidTakenError, VmidReservations, VMID_MIN } from './utils/vmidAllocator.js';

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

// The ACTIVE (on-disk) config, ignoring pending changes. The default config
// endpoint returns pending values merged in — for a running VM that hides the
// fact that a change (e.g. boot order) has only been staged, not applied. This
// is what Proxmox ships for a cross-host migration, so it's the source of
// truth for pre-migration validation. Never cached.
export async function getVMConfigCurrent(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/config?current=1`);
}

// Addresses as the guest itself sees them. Requires qemu-guest-agent running
// inside the VM — Proxmox answers 500 when the agent is absent, stopped, or
// the VM is powered off, so every caller must treat a rejection as "unknown",
// never as an error worth surfacing.
export async function getVMAgentInterfaces(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/agent/network-get-interfaces`);
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

// In-flight VMID reservations. The id is chosen from a snapshot of what Proxmox
// reports and nothing upstream holds it, so without this two deploys started at
// the same time are handed the same id and the second create fails with a raw
// "already exists". The backend is single-process — the same assumption the
// tag-sync scheduler makes — so an in-process set is enough. Entries expire on
// their own (see VmidReservations) in case a caller never releases.
const vmidReservations = new VmidReservations();

// Hand a reserved id back early — call this when the create/clone that was
// going to use it failed, so a botched deploy doesn't burn the id for the full
// reservation TTL.
export function releaseVmid(vmid) {
  return vmidReservations.release(vmid);
}

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
  let startAt = VMID_MIN;
  if (usedIds.size === 0) {
    // No VMs anywhere — ask any reachable host for its default next ID
    for (const h of hosts) {
      try {
        const next = Number.parseInt(await makeRequest(h, 'GET', '/cluster/nextid'), 10);
        if (Number.isInteger(next)) { startAt = next; break; }
      } catch { /* next */ }
    }
  }
  // Lowest free VMID that no other in-flight deploy is already holding
  const vmid = pickVmid(usedIds, vmidReservations.active(), startAt);
  vmidReservations.reserve(vmid);
  return vmid;
}

// Allocate a VMID, run `fn(vmid)` (the createVM / cloneVM call), and self-heal
// the one collision the reservation set can't prevent: an id Proxmox reported
// as free that something outside this process took in the meantime. Returns
// `{ vmid, result }`.
//
// On a collision the losing id stays reserved — it is genuinely taken upstream
// — and one retry runs against a fresh allocation. Any other failure releases
// the reservation immediately so a failed deploy doesn't burn an id.
export async function withFreshVmid(fn) {
  const vmid = await getNextVmid();
  try {
    return { vmid, result: await fn(vmid) };
  } catch (err) {
    if (!isVmidTakenError(err)) {
      releaseVmid(vmid);
      throw err;
    }
    console.warn(`[vmid] ${vmid} was taken upstream — retrying with a fresh id`);
  }

  const retryVmid = await getNextVmid();
  try {
    return { vmid: retryVmid, result: await fn(retryVmid) };
  } catch (err) {
    if (!isVmidTakenError(err)) releaseVmid(retryVmid);
    throw err;
  }
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

// Resolve a node ref to the id of the pve_hosts row that owns it. Used by the
// storage-visibility guard, which is keyed by (pve_host_id, storage).
export async function getHostIdForNode(node) {
  const host = await hostForNode(node);
  return host.id;
}

// All storage pools configured on a host (cluster-wide storage.cfg view), so the
// admin exposure UI can list every pool — including ones not currently active on
// a particular node. Takes a raw pve_hosts row.
export async function getHostStoragePools(host) {
  const pools = await makeRequest(host, 'GET', '/storage');
  return pools || [];
}

export async function getISOImages(node, storage) {
  const { host, nodeName } = await resolveNode(node);
  const content = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/storage/${encodeURIComponent(storage)}/content?content=iso`);
  return content || [];
}

// Ask PVE to download a file from a URL into a storage. Defaults to `import`
// content — the only content type (besides images) that qemu's import-from
// accepts as a disk source on PVE 9; the storage must have the Import content
// type enabled. Pass content='iso' to populate the ISO catalog (storage needs
// the ISO content type enabled). Returns the download task UPID.
export async function downloadUrlToStorage(node, storage, url, filename, checksum, checksumAlgorithm, content = 'import') {
  const { host, nodeName } = await resolveNode(node);
  const body = { content, url, filename };
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

// Task log lines as `[{ n, t }]`, `n` being the 1-based line number. Reading is
// forward-only (PVE has no tail parameter), so callers keep the last `n` they
// saw and pass it back as `start` to pick up where they left off.
export async function getTaskLog(node, upid, { start = 0, limit = 50 } = {}) {
  const { host, nodeName } = await resolveNode(node);
  const query = `?start=${Number(start) || 0}&limit=${Number(limit) || 50}`;
  return makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/tasks/${encodeURIComponent(upid)}/log${query}`);
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

// Detect whether a VMID is a qemu VM or an lxc container on its host, returning
// both the type and its current status row.
async function detectGuest(host, nodeName, vmid) {
  try {
    const status = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/status/current`);
    return { vmtype: 'qemu', status };
  } catch {
    const status = await makeRequest(host, 'GET', `/nodes/${encodeURIComponent(nodeName)}/lxc/${vmid}/status/current`);
    return { vmtype: 'lxc', status };
  }
}

// Public form of detectGuest for callers that only need the type and must
// tolerate the VMID not existing yet (a restore may be creating it). Returns
// null when neither endpoint knows the VMID, or when the host can't be probed
// at all — the caller falls back to whatever else it knows.
export async function getGuestType(node, vmid) {
  try {
    const { host, nodeName } = await resolveNode(node, { vmid });
    const { vmtype } = await detectGuest(host, nodeName, vmid);
    return vmtype;
  } catch {
    return null;
  }
}

// Scheduler-driven graceful stop: ask the guest OS to shut down and wait up to
// `timeoutMs`; if it doesn't stop in time, fall back to a hard stop. Returns
// `{ method }` describing what actually stopped it ('none' | 'shutdown' | 'stop').
export async function scheduledStopVM(node, vmid, { timeoutMs = 120_000 } = {}) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  const { vmtype, status } = await detectGuest(host, nodeName, vmid);
  if (status.status === 'stopped') return { vmtype, method: 'none' };

  const base = `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/status`;
  try {
    await makeRequest(host, 'POST', `${base}/shutdown`, {});
    await waitForGuestStopped(host, nodeName, vmtype, vmid, timeoutMs);
    return { vmtype, method: 'shutdown' };
  } catch (shutdownErr) {
    // Graceful shutdown timed out or was refused — force it off.
    await makeRequest(host, 'POST', `${base}/stop`, {});
    await waitForGuestStopped(host, nodeName, vmtype, vmid, 60_000);
    return { vmtype, method: 'stop', shutdownError: shutdownErr.message };
  }
}

// Scheduler-driven start (qemu or lxc). No-op if already running.
export async function scheduledStartVM(node, vmid) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  const { vmtype, status } = await detectGuest(host, nodeName, vmid);
  if (status.status === 'running') return { vmtype, method: 'none' };
  await makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/status/start`, {});
  return { vmtype, method: 'start' };
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

// ── Cross-host (remote) migration ────────────────────────────────────────────

// Cluster-wide storage definitions (/storage — storage.cfg entries, including
// nfs server/export and cifs server/share). Used to detect storage that is
// mounted by more than one registered host.
export function getStorageDefs(host) {
  return makeRequest(host, 'GET', '/storage');
}

// Move (or reassign) one disk of a stopped/running VM. `POST move_disk`.
// opts: { storage, delete, format }. Returns task UPID.
export async function moveVmDisk(node, vmid, disk, opts = {}) {
  const { host, nodeName } = await resolveNode(node, { vmid });
  const body = { disk, ...(opts.storage && { storage: opts.storage }) };
  if (opts.delete) body.delete = 1;
  if (opts.format) body.format = opts.format;
  clearCachedVmConfig(node, vmid, 'qemu');
  return makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmid}/move_disk`, body);
}

// Public task-wait helper for multi-step orchestration (migration adopt flow).
// Throws on task failure or timeout. `onPoll` runs once per tick while the task
// is still going (progress reporting) — its failures never abort the wait.
export async function waitForTask(node, upid, { timeoutMs = 4 * 60 * 60 * 1000, intervalMs = 4000, onPoll = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let task = null;
    try {
      task = await getTaskStatus(node, upid);
    } catch { /* transient — keep waiting */ }
    if (onPoll && !(task && task.status === 'stopped')) {
      try { await onPoll(); } catch { /* progress is best-effort */ }
    }
    if (task && task.status === 'stopped') {
      if (task.exitstatus !== 'OK') throw new Error(`Proxmox task failed: ${task.exitstatus}`);
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for Proxmox task to complete');
}

// SHA-256 fingerprint of the TLS certificate a host actually serves, in the
// colon-separated form `remote_migrate` expects. The source PVE host pins the
// target's certificate by this fingerprint, so it must come from a live
// connection. The connection follows the same TLS policy as every other call
// to the host (assertSecureTls + per-host verify_tls).
export function getHostCertFingerprint(host) {
  assertSecureTls(host);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: host.host,
      port: host.port,
      rejectUnauthorized: host.verify_tls !== 0,
    }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.fingerprint256) {
        reject(new Error(`Could not read the TLS certificate fingerprint of ${host.name || host.host}`));
        return;
      }
      resolve(cert.fingerprint256);
    });
    socket.setTimeout(10000, () => socket.destroy(new Error(`Timed out reading the TLS certificate of ${host.name || host.host}`)));
    socket.on('error', reject);
  });
}

// Start a cross-cluster migration (PVE `remote_migrate`, 7.3+ / experimental —
// the API behind `qm remote-migrate` / `pct remote-migrate`). The source host
// drives the task and connects to the target by API token + certificate
// fingerprint; the guest lands on the node behind the target host's API
// address. The VMID is kept (the portal allocates VMIDs globally unique across
// hosts). Returns the UPID of the migration task on the source node.
export async function remoteMigrateVm(sourceNode, vmid, vmtype, targetHost, opts = {}) {
  const { host, nodeName } = await resolveNode(sourceNode, { vmid });
  if (host.id === targetHost.id) {
    throw new Error('Source and target are the same Proxmox host');
  }
  assertSecureTls(targetHost, 'Target Proxmox host');

  const fingerprint = await getHostCertFingerprint(targetHost);
  const endpoint = [
    `host=${targetHost.host}`,
    `port=${targetHost.port}`,
    `apitoken=PVEAPIToken=${targetHost.token_id}=${decryptSecret(targetHost.token_secret)}`,
    `fingerprint=${fingerprint}`,
  ].join(',');

  const body = {
    'target-endpoint': endpoint,
    'target-storage': opts.targetStorage,
    'target-bridge': opts.targetBridge,
    'target-vmid': Number.parseInt(vmid, 10),
    delete: opts.deleteSource ? 1 : 0,
  };
  // QEMU supports live migration (`online`); LXC only offline or restart mode.
  if (vmtype === 'qemu') body.online = opts.online ? 1 : 0;
  else body.restart = opts.restart ? 1 : 0;

  const upid = await makeRequest(host, 'POST', `/nodes/${encodeURIComponent(nodeName)}/${vmtype}/${vmid}/remote_migrate`, body);
  clearCachedVmConfig(sourceNode, vmid, vmtype);
  _vmCache = { data: null, expires: 0 };
  return upid;
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
