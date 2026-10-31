// Regenerates docs/screenshots/*.png against a fully mocked API (no backend,
// no real hosts). Run: npm run screenshots   (from frontend/)
import { test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const GB = 1024 ** 3;
const admin = { id: 1, username: 'operator', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };

const vm = (vmid, name, node, status, cpu, mem, maxmem, extra = {}) => ({
  vmid, name, node, nodeRef: `1~${node}`, hostName: 'lab-cluster', type: 'qemu', status, cpu, mem: mem * GB, maxmem: maxmem * GB,
  maxcpu: 4, ...extra,
});
const soon = (d) => new Date(Date.now() + d * 864e5).toISOString();
const vms = [
  vm(101, 'web-01', 'pve1', 'running', 0.12, 1.4, 4, { lease: { hasLease: true, status: 'active', expiresAt: soon(21), daysRemaining: 21 } }),
  vm(102, 'db-01', 'pve1', 'running', 0.34, 5.8, 8, { lease: { hasLease: true, status: 'active', expiresAt: soon(40), daysRemaining: 40 } }),
  vm(103, 'media-server', 'pve2', 'running', 0.58, 3.1, 4),
  vm(104, 'k3s-node-1', 'pve2', 'running', 0.21, 2.9, 8, { lease: { hasLease: true, status: 'expiring', expiresAt: soon(3), daysRemaining: 3 } }),
  vm(105, 'build-runner', 'pve1', 'stopped', 0, 0, 4, { schedule: { enabled: true, stopTime: '23:00', startTime: '08:00', days: 31, timezone: 'Europe/Copenhagen' } }),
  vm(106, 'dns-01', 'pve1', 'running', 0.03, 0.2, 1, { type: 'lxc' }),
  vm(107, 'wiki', 'pve2', 'running', 0.05, 0.6, 2, { type: 'lxc' }),
  vm(108, 'game-server', 'pve2', 'stopped', 0, 0, 8),
];

const rrd = Array.from({ length: 60 }, (_, i) => ({
  time: 1700000000 + i * 60,
  cpu: 0.15 + 0.1 * Math.sin(i / 5) + (i % 7) * 0.01,
  mem: (1.4 + 0.2 * Math.sin(i / 9)) * GB, maxmem: 4 * GB,
  netin: 40000 + 25000 * Math.abs(Math.sin(i / 4)), netout: 20000 + 15000 * Math.abs(Math.cos(i / 6)),
  diskread: 8000 + 4000 * Math.abs(Math.sin(i / 3)), diskwrite: 30000 + 20000 * Math.abs(Math.cos(i / 5)),
}));

const fw = { id: 1, name: 'edge-fw', host: '192.0.2.1', external_ip: '203.0.113.10', root_wan_zone: 'underlay' };
const vlans = [
  { id: 1, tag: 10, name: 'servers', description: 'Production workloads', mode: 'managed', subnet: { network: '10.10.0.0/24' }, firewallSync: [{ firewallName: 'edge-fw', subnet: '10.10.0.0/24' }] },
  { id: 2, tag: 20, name: 'lab', description: 'Disposable test VMs', mode: 'managed', subnet: { network: '10.20.0.0/24' }, firewallSync: [{ firewallName: 'edge-fw', subnet: '10.20.0.0/24' }] },
  { id: 3, tag: 30, name: 'iot', description: 'Untrusted devices', mode: 'managed', subnet: { network: '10.30.0.0/24' }, firewallSync: [{ firewallName: 'edge-fw', subnet: '10.30.0.0/24' }] },
  { id: 4, tag: 40, name: 'dmz', description: 'Public-facing services', mode: 'managed', subnet: { network: '10.40.0.0/24' }, firewallSync: [{ firewallName: 'edge-fw', subnet: '10.40.0.0/24' }] },
  { id: 5, tag: 99, name: 'storage', description: 'NFS / iSCSI', mode: 'tagged_only', subnet: { network: '10.99.0.0/24' }, firewallSync: [] },
];
const vips = [
  { name: 'Web - HTTPS 443/tcp', managed: true, protocol: 'tcp', extport: 443, mappedip: '10.40.0.11', mappedport: 443 },
  { name: 'Minecraft - Custom 25565/tcp', managed: true, protocol: 'tcp', extport: 25565, mappedip: '10.20.0.15', mappedport: 25565 },
  { name: 'WireGuard - Custom 51820/udp', managed: true, protocol: 'udp', extport: 51820, mappedip: '10.10.0.5', mappedport: 51820 },
  { name: 'legacy-ssh', managed: false, protocol: 'tcp', extport: 2222, mappedip: '10.10.0.20', mappedport: 22 },
];
const images = [
  { id: 1, name: 'Ubuntu 24.04 LTS', nodeRef: '1~pve1', node: '1~pve1', hostName: 'lab-cluster', storage: 'local', size: 620 * 1024 ** 2, url: 'u1' },
  { id: 2, name: 'Debian 12 Bookworm', nodeRef: '1~pve1', node: '1~pve1', hostName: 'lab-cluster', storage: 'local', size: 410 * 1024 ** 2, url: 'u2' },
  { id: 3, name: 'Rocky Linux 9', nodeRef: '1~pve2', node: '1~pve2', hostName: 'lab-cluster', storage: 'local', size: 580 * 1024 ** 2, url: 'u3' },
  { id: 4, name: 'Ubuntu 22.04 LTS', nodeRef: '1~pve2', node: '1~pve2', hostName: 'lab-cluster', storage: 'local', size: 640 * 1024 ** 2, url: 'u4' },
];

function respond(url, method) {
  const p = url.pathname.replace(/^\/api/, '');
  if (method !== 'GET') return {};
  if (p === '/auth/me') return admin;
  if (p === '/vms') return vms;
  if (/^\/vms\/[^/]+\/\d+\/status$/.test(p)) return { ...vms[0], uptime: 1234567, cpus: 4, netin: 9e9, netout: 3e9, diskread: 2e10, diskwrite: 5e10 };
  if (p.endsWith('/rrddata')) return rrd;
  if (p.endsWith('/config')) return { scsi0: 'local-lvm:vm-101-disk-0,size=32G', net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0,tag=10' };
  if (p.endsWith('/schedule')) return { schedule: null };
  if (p === '/admin/firewalls') return [fw];
  if (p === '/admin/vlans') return vlans;
  if (p === '/admin/firewalls/1/vips') return vips;
  if (p === '/admin/firewalls/1/vm-targets') return { targets: [] };
  if (p === '/provision/images') return images;
  if (p === '/vms/my-vlans') return vlans.slice(0, 4);
  if (p === '/provision/quota') return {};
  if (p === '/portal/status') return { maintenance: [] };
  if (p.endsWith('/storages')) return [{ storage: 'local-lvm', content: 'images,rootdir', avail: 400 * GB, total: 900 * GB }];
  if (p.endsWith('/networks')) return [{ iface: 'vmbr0' }];
  return [];
}

test.beforeEach(async ({ context }) => {
  await context.route('**/api/**', (route) => {
    const req = route.request();
    return route.fulfill({ json: respond(new URL(req.url()), req.method()) });
  });
});

const shots = [
  ['dashboard', '/dashboard'],
  ['vm-detail', '/vm/1~pve1/101'],
  ['deploy', '/provision'],
  ['vlans', '/admin/vlans'],
  ['port-forwarding', '/admin/port-forwarding'],
];
for (const [name, url] of shots) {
  test(name, async ({ page }) => {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    if (name === 'deploy') await page.getByRole('button', { name: /Ubuntu 24.04/ }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  });
}
