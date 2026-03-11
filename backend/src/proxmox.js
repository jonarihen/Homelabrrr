import https from 'https';
import db from './db.js';

function agentForHost(host) {
  return new https.Agent({ rejectUnauthorized: !!host.verify_tls });
}

// ── Per-host API request ─────────────────────────────────────────────────────

function makeRequest(host, method, path, body) {
  const url = new URL(`https://${host.host}:${host.port}/api2/json${path}`);
  const authHeader = `PVEAPIToken=${host.token_id}=${host.token_secret}`;
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

// Find the host that owns a given node name
async function hostForNode(nodeName) {
  const hosts = getHosts();
  for (const h of hosts) {
    try {
      const nodes = await makeRequest(h, 'GET', '/nodes');
      if (nodes.some(n => n.node === nodeName)) return h;
    } catch { /* skip unreachable host */ }
  }
  // Fallback to default
  return defaultHost();
}

// ── Proxmox API wrappers ─────────────────────────────────────────────────────

export const proxmoxGet  = (path)       => makeRequest(defaultHost(), 'GET', path);
export const proxmoxPost = (path, body) => makeRequest(defaultHost(), 'POST', path, body ?? {});
export const proxmoxPut  = (path, body) => makeRequest(defaultHost(), 'PUT', path, body ?? {});

// Host-aware variants
export const hostGet  = (host, path)       => makeRequest(host, 'GET', path);
export const hostPost = (host, path, body) => makeRequest(host, 'POST', path, body ?? {});
export const hostPut  = (host, path, body) => makeRequest(host, 'PUT', path, body ?? {});

export async function getAllVMs() {
  const hosts = getHosts();
  const allVms = [];
  for (const h of hosts) {
    try {
      const resources = await makeRequest(h, 'GET', '/cluster/resources?type=vm');
      allVms.push(...resources.filter(r => r.type === 'qemu' || r.type === 'lxc'));
    } catch (err) {
      console.warn(`Failed to fetch VMs from ${h.name} (${h.host}): ${err.message}`);
    }
  }
  return allVms;
}

export async function getVMStatus(node, vmid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/qemu/${vmid}/status/current`);
}

export async function vmAction(node, vmid, action) {
  const host = await hostForNode(node);
  return makeRequest(host, 'POST', `/nodes/${node}/qemu/${vmid}/status/${action}`, {});
}

export async function getVNCTicket(node, vmid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'POST', `/nodes/${node}/qemu/${vmid}/vncproxy`, { websocket: 1 });
}

export async function getVMConfig(node, vmid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/qemu/${vmid}/config`);
}

export async function updateVMConfig(node, vmid, config) {
  const host = await hostForNode(node);
  return makeRequest(host, 'PUT', `/nodes/${node}/qemu/${vmid}/config`, config);
}

export async function getLXCStatus(node, vmid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/lxc/${vmid}/status/current`);
}

export async function lxcAction(node, vmid, action) {
  const host = await hostForNode(node);
  return makeRequest(host, 'POST', `/nodes/${node}/lxc/${vmid}/status/${action}`, {});
}

export async function getLXCConfig(node, vmid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/lxc/${vmid}/config`);
}

export async function updateLXCConfig(node, vmid, config) {
  const host = await hostForNode(node);
  return makeRequest(host, 'PUT', `/nodes/${node}/lxc/${vmid}/config`, config);
}

export async function getLXCRRD(node, vmid, timeframe = 'hour') {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/lxc/${vmid}/rrddata?timeframe=${timeframe}`);
}

export async function getLXCVNCTicket(node, vmid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'POST', `/nodes/${node}/lxc/${vmid}/vncproxy`, { websocket: 1 });
}

export async function getVMRRD(node, vmid, type = 'qemu', timeframe = 'hour') {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/${type}/${vmid}/rrddata?timeframe=${timeframe}`);
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
      nodes: nodes.map(n => ({ node: n.node, status: n.status, cpu: n.cpu, mem: n.mem, maxmem: n.maxmem, uptime: n.uptime })),
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
  // Get next free ID from the first reachable host (cluster-wide)
  for (const h of hosts) {
    try {
      return await makeRequest(h, 'GET', '/cluster/nextid');
    } catch { /* try next */ }
  }
  throw new Error('No reachable PVE hosts');
}

export async function cloneVM(node, templateVmid, newVmid, name, opts = {}) {
  const host = await hostForNode(node);
  const body = {
    newid: newVmid,
    name,
    full: 1,  // full clone (not linked)
    ...(opts.target && { target: opts.target }),
    ...(opts.storage && { storage: opts.storage }),
    ...(opts.description && { description: opts.description }),
  };
  return makeRequest(host, 'POST', `/nodes/${node}/qemu/${templateVmid}/clone`, body);
}

export async function createVM(node, vmid, config) {
  const host = await hostForNode(node);
  return makeRequest(host, 'POST', `/nodes/${node}/qemu`, { vmid, ...config });
}

export async function resizeVMDisk(node, vmid, disk, size) {
  const host = await hostForNode(node);
  return makeRequest(host, 'PUT', `/nodes/${node}/qemu/${vmid}/resize`, { disk, size });
}

export async function getStorages(node) {
  const host = await hostForNode(node);
  const storages = await makeRequest(host, 'GET', `/nodes/${node}/storage`);
  return storages.filter(s => s.active && s.enabled);
}

export async function getISOImages(node, storage) {
  const host = await hostForNode(node);
  const content = await makeRequest(host, 'GET', `/nodes/${node}/storage/${storage}/content?content=iso`);
  return content || [];
}

export async function getNetworks(node) {
  const host = await hostForNode(node);
  const nets = await makeRequest(host, 'GET', `/nodes/${node}/network`);
  return (nets || []).filter(n => n.type === 'bridge');
}

export async function getNodes() {
  const hosts = getHosts();
  const allNodes = [];
  for (const h of hosts) {
    try {
      const nodes = await makeRequest(h, 'GET', '/nodes');
      allNodes.push(...nodes.map(n => ({ ...n, hostId: h.id, hostName: h.name })));
    } catch { /* skip */ }
  }
  return allNodes;
}

export async function getTaskStatus(node, upid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
}

// ── Snapshot helpers ─────────────────────────────────────────────────────────

export async function getSnapshots(node, vmid, vmtype = 'qemu') {
  const host = await hostForNode(node);
  return makeRequest(host, 'GET', `/nodes/${node}/${vmtype}/${vmid}/snapshot`);
}

export async function createSnapshot(node, vmid, vmtype = 'qemu', name, description = '', vmstate = false) {
  const host = await hostForNode(node);
  const body = { snapname: name, ...(description && { description }), ...(vmtype === 'qemu' && { vmstate: vmstate ? 1 : 0 }) };
  return makeRequest(host, 'POST', `/nodes/${node}/${vmtype}/${vmid}/snapshot`, body);
}

export async function deleteSnapshot(node, vmid, vmtype = 'qemu', snapname) {
  const host = await hostForNode(node);
  return makeRequest(host, 'DELETE', `/nodes/${node}/${vmtype}/${vmid}/snapshot/${encodeURIComponent(snapname)}`);
}

export async function rollbackSnapshot(node, vmid, vmtype = 'qemu', snapname) {
  const host = await hostForNode(node);
  return makeRequest(host, 'POST', `/nodes/${node}/${vmtype}/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`, {});
}

// ── Backup helpers ──────────────────────────────────────────────────────────

export async function getVMBackups(node, vmid) {
  const host = await hostForNode(node);
  // List all storages, then check each backup-capable one for this VM's backups
  const storages = await makeRequest(host, 'GET', `/nodes/${node}/storage`);
  const backupStorages = storages.filter(s => s.active && s.enabled && s.content?.includes('backup'));
  const allBackups = [];
  for (const s of backupStorages) {
    try {
      const content = await makeRequest(host, 'GET', `/nodes/${node}/storage/${s.storage}/content?content=backup&vmid=${vmid}`);
      if (content) allBackups.push(...content.map(b => ({ ...b, storage: s.storage })));
    } catch { /* skip */ }
  }
  // Sort newest first
  allBackups.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
  return allBackups;
}

export async function createVMBackup(node, vmid, opts = {}) {
  const host = await hostForNode(node);
  const body = {
    vmid: parseInt(vmid),
    mode: opts.mode || 'snapshot',
    compress: opts.compress || 'zstd',
    ...(opts.storage && { storage: opts.storage }),
    ...(opts.notes && { 'notes-template': opts.notes }),
  };
  return makeRequest(host, 'POST', `/nodes/${node}/vzdump`, body);
}

export async function restoreVMBackup(node, vmid, archive, storage, vmtype = 'qemu') {
  const host = await hostForNode(node);
  const body = {
    vmid: parseInt(vmid),
    archive,
    force: 1,
    ...(storage && { storage }),
  };
  return makeRequest(host, 'POST', `/nodes/${node}/${vmtype}`, body);
}

export async function deleteVMBackup(node, storage, volid) {
  const host = await hostForNode(node);
  return makeRequest(host, 'DELETE', `/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`);
}

export async function getBackupStorages(node) {
  const host = await hostForNode(node);
  const storages = await makeRequest(host, 'GET', `/nodes/${node}/storage`);
  return storages.filter(s => s.active && s.enabled && s.content?.includes('backup'));
}

// ── File-level restore from backups ─────────────────────────────────────────

export async function listBackupFiles(node, storage, volid, filepath = '/') {
  const host = await hostForNode(node);
  const params = new URLSearchParams({ volume: volid, filepath });
  return makeRequest(host, 'GET', `/nodes/${node}/storage/${storage}/file-restore/list?${params}`);
}

export async function downloadBackupFile(node, storage, volid, filepath) {
  const host = await hostForNode(node);
  const params = new URLSearchParams({ volume: volid, filepath });
  const baseUrl = `https://${host.host}:${host.port}/api2/json`;
  const authHeader = `PVEAPIToken=${host.token_id}=${host.token_secret}`;
  const url = `${baseUrl}/nodes/${node}/storage/${storage}/file-restore/download?${params}`;

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
  return {
    host: host.host,
    port: host.port,
    tokenId: host.token_id,
    tokenSecret: host.token_secret,
    verifyTls: !!host.verify_tls,
  };
}
