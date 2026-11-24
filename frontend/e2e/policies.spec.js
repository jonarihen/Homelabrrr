import { test, expect } from '@playwright/test';

// Policy mesh on /admin/policies with a mocked API only: no backend or
// FortiGate is contacted. Every page call is recorded so the tests pin the
// exact endpoints, payloads and order the page sends.
const admin = { id: 1, username: 'owner', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };
const delegate = { id: 7, username: 'netops', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions: { canManagePolicies: true } };
const firewalls = [{ id: 1, name: 'edge-fw' }, { id: 2, name: 'lab-fw' }];
const vlan = (id, tag, name, subnet, synced = [1]) => ({
  id, tag, name, subnet: { network: subnet }, firewallSync: synced.map((firewallId) => ({ firewallId, subnet })),
});
const vlans = [
  vlan(1, 10, 'servers', '10.10.0.0/24'),
  vlan(2, 20, 'lab', '10.20.0.0/24'),
  vlan(3, 30, 'iot', '10.30.0.0/24'),
  vlan(4, 40, 'dmz', '10.40.0.0/24', [1, 2]),
  vlan(5, 99, 'storage', '10.99.0.0/24', []),
];
const ref = (v) => ({ id: v.id, name: v.name, tag: v.tag });
const policy = (policyid, src, dst, service, action = 'accept', extra = {}) => ({
  policyid, name: `p${policyid}`, srcintf: `vl${src.tag}`, dstintf: dst ? `vl${dst.tag}` : 'lab-root0', service, action,
  globalLabel: '', isInternet: !dst, srcVlan: ref(src), dstVlan: dst ? ref(dst) : null, ...extra,
});
const policies = [
  policy(11, vlans[0], vlans[1], ['HTTPS', 'SSH'], 'accept', { globalLabel: 'servers-lab' }),
  policy(12, vlans[1], vlans[2], ['ALL'], 'deny'),
  policy(13, vlans[0], null, ['ALL']),
  policy(14, vlans[3], vlans[0], ['DNS', 'PING']),
];
const addresses = [
  { name: 'NET-10.10.0.0_24', type: 'ipmask', subnet: '10.10.0.0 255.255.255.0', fqdn: '', comment: '' },
  { name: 'docs-site', type: 'fqdn', subnet: '', fqdn: 'docs.example.test', comment: '' },
];
const services = [
  { name: 'Minecraft', protocol: 'TCP/UDP/SCTP', tcpPortrange: '25565', udpPortrange: '', comment: '' },
  { name: 'SIP', protocol: 'TCP/UDP/SCTP', tcpPortrange: '', udpPortrange: '5060', comment: '' },
];
const PAGE_API = /\/api\/admin\/(firewalls|vlans|policies|objects)/;

async function mockPolicies(page, { user = admin, failFirstCreate = false } = {}) {
  const calls = [];
  let createAttempts = 0;
  await page.route('**/api/**', (route) => route.fulfill({ json: route.request().method() === 'GET' ? [] : {} }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route(PAGE_API, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/^\/api/, '');
    calls.push({ method, url: `${path}${url.search}`, ...(request.postData() ? { body: request.postDataJSON() } : {}) });
    if (method === 'GET') {
      const fwId = url.searchParams.get('firewallId');
      if (path === '/admin/firewalls') return route.fulfill({ json: firewalls });
      if (path === '/admin/vlans') return route.fulfill({ json: vlans });
      if (path === '/admin/policies') return route.fulfill({ json: fwId === '1' ? policies : [] });
      if (path === '/admin/objects/addresses') return route.fulfill({ json: addresses });
      if (path === '/admin/objects/services') return route.fulfill({ json: services });
    }
    if (method === 'POST' && path === '/admin/policies') {
      createAttempts += 1;
      if (failFirstCreate && createAttempts === 1) return route.fulfill({ status: 400, json: { error: 'Source VLAN 10 not synced to this firewall' } });
      return route.fulfill({ json: { policyIds: [21, 22] } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  return { calls, take: () => calls.splice(0) };
}

const node = (page, tag) => page.locator('button', { hasText: new RegExp(`^VLAN ${tag}\\D`) });
const tab = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}`) });
const row = (page, text) => page.locator('[class*="hover:bg-gray-800/20"]', { hasText: text });
// Selecting a source re-lays out the mesh (460ms animation); wait for nodes to stop moving.
const layout = (page) => page.locator('button', { hasText: /^VLAN \d/ })
  .evaluateAll((els) => els.map((el) => `${el.style.left},${el.style.top},${getComputedStyle(el).transform}`).join('|'));
const settled = (page) => expect.poll(async () => {
  const before = await layout(page);
  await page.waitForTimeout(150);
  return before === await layout(page);
}).toBe(true);
const pickRoute = async (page, src, dst) => {
  await node(page, src).click();
  await settled(page);
  await node(page, dst).click();
};
const openPage = async (page, options) => {
  const api = await mockPolicies(page, options);
  await page.goto('/admin/policies');
  await expect(node(page, 10)).toBeVisible();
  await expect.poll(() => api.calls.length).toBe(4);
  api.take();
  return api;
};
const confirmDelete = async (page, message) => {
  const dialog = page.getByRole('dialog', { name: /confirm/i }).or(page.getByRole('dialog').filter({ hasText: message }));
  await expect(dialog).toContainText(message);
  await dialog.getByRole('button', { name: 'Delete' }).click();
};

test('the mesh renders the synced VLANs, legend and summary cards', async ({ page }) => {
  const api = await mockPolicies(page);
  await page.goto('/admin/policies');
  await expect(page.getByRole('heading', { name: 'Policy Mesh' })).toBeVisible();
  await expect.poll(() => api.calls.length).toBe(4);
  expect(api.take()).toEqual([
    { method: 'GET', url: '/admin/firewalls' },
    { method: 'GET', url: '/admin/firewalls' }, // dev StrictMode runs the mount effect twice
    { method: 'GET', url: '/admin/vlans' },
    { method: 'GET', url: '/admin/policies?firewallId=1' },
  ]);
  for (const tag of [10, 20, 30, 40]) await expect(node(page, tag)).toBeVisible();
  await expect(node(page, 99)).toHaveCount(0); // not synced to this firewall
  await expect(node(page, 10)).toContainText('2 routes');
  await expect(node(page, 10)).toContainText('2 peers');
  for (const label of ['All Traffic', 'HTTPS', 'Ping', 'All UDP', 'Deny']) {
    await expect(page.locator('span.rounded-full', { hasText: new RegExp(`^${label}$`) }).first()).toBeVisible();
  }
  await expect(page.getByText('4 VLANs in this firewall mesh')).toBeVisible();
  await expect(page.locator('select')).toHaveValue('1');
  await expect(page.locator('svg path[stroke="transparent"]')).toHaveCount(3); // internet policy has no line
  await expect(page.getByText('No VLAN selected. Click any node in the mesh to start routing from that source.')).toBeVisible();
});

test('search, zoom and the firewall picker drive the mesh', async ({ page }) => {
  const api = await openPage(page);
  // Search fades non-matching nodes and rings matches.
  await page.getByPlaceholder('Find VLAN...').fill('io');
  await expect(node(page, 30)).toHaveClass(/ring-2/);
  await expect(node(page, 10)).toHaveCSS('opacity', '0.22');
  await page.getByPlaceholder('Find VLAN...').locator('xpath=..').getByRole('button').click();
  await expect(page.getByPlaceholder('Find VLAN...')).toHaveValue('');

  // Zoom controls and recenter.
  await expect(page.getByRole('button', { name: 'Recenter' })).toHaveCount(0);
  await page.getByTitle('Zoom in').click();
  await expect(page.getByText('125%')).toBeVisible();
  await page.getByTitle('Zoom out').click();
  await page.getByTitle('Zoom out').click();
  await expect(page.getByText('80%')).toBeVisible();
  await page.getByRole('button', { name: 'Recenter' }).click();
  await expect(page.getByText('100%')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recenter' })).toHaveCount(0);

  // Switching firewall reloads that firewall's mesh.
  await page.locator('select').selectOption('2');
  await expect(page.getByText('1 VLANs in this firewall mesh')).toBeVisible();
  await expect.poll(() => api.calls.length).toBe(2);
  expect(api.take()).toEqual([
    { method: 'GET', url: '/admin/vlans' },
    { method: 'GET', url: '/admin/policies?firewallId=2' },
  ]);
});

test('a source selection highlights its peers and steps back out', async ({ page }) => {
  await openPage(page);
  await node(page, 10).click();
  await expect(page.getByText('Source locked on servers.', { exact: false })).toBeVisible();
  await expect(node(page, 10)).toContainText('Source');
  await expect(node(page, 20)).toContainText('Linked');
  await expect(node(page, 30)).toContainText('Open');
  await expect(page.getByText('2 linked VLANs, 3 visible routes')).toBeVisible();
  await expect(page.getByText('Existing Paths')).toBeVisible();
  await expect(page.getByText('2 linked VLANs already share a policy with this source.')).toBeVisible();

  // Esc steps back out of the source selection; Clear Selection does too.
  await page.keyboard.press('Escape');
  await expect(page.getByText('No source selected')).toBeVisible();
  await node(page, 10).click();
  await page.getByRole('button', { name: 'Clear Selection' }).click();
  await expect(page.getByText('No source selected')).toBeVisible();
  // Clicking the source again also clears it.
  await node(page, 10).click();
  await node(page, 10).click();
  await expect(page.getByText('No source selected')).toBeVisible();
});

test('picking source and destination opens the create modal and posts the exact payload', async ({ page }) => {
  const api = await openPage(page, { failFirstCreate: true });
  await pickRoute(page, 10, 30);
  const modal = page.getByRole('dialog', { name: 'Create Policy' });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('servers');
  await expect(modal).toContainText('10.30.0.0/24');
  await expect(modal).toContainText('Allow all traffic from servers to iot.');
  await expect(modal).toContainText('1 firewall rule');
  await expect(modal).toContainText('Direction: one-way');

  await modal.getByRole('button', { name: 'SSH', exact: true }).click();
  await modal.getByRole('button', { name: 'HTTPS', exact: true }).click();
  await modal.getByRole('button', { name: 'Ping', exact: true }).click();
  await modal.getByRole('button', { name: 'Ping', exact: true }).click();
  await modal.getByText('Bidirectional').locator('xpath=../preceding-sibling::div').click();
  await expect(modal).toContainText('Also allow iot to reach servers');
  await expect(modal).toContainText('2 firewall rules');
  await expect(modal).toContainText('Direction: two-way');
  await expect(modal).toContainText(', and mirror the same access back from iot to servers.');

  await modal.getByRole('button', { name: 'Create Rule' }).click();
  await expect(modal).toContainText('Source VLAN 10 not synced to this firewall');
  await modal.getByRole('button', { name: 'Create Rule' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByText('No source selected')).toBeVisible();
  await expect.poll(() => api.calls.length).toBe(4);
  const payload = { firewallId: 1, srcVlanTag: 10, dstVlanTag: 30, services: ['SSH', 'HTTPS'], action: 'accept', bidirectional: true };
  expect(api.take()).toEqual([
    { method: 'POST', url: '/admin/policies', body: payload },
    { method: 'POST', url: '/admin/policies', body: payload },
    { method: 'GET', url: '/admin/vlans' },
    { method: 'GET', url: '/admin/policies?firewallId=1' },
  ]);

});

test('the create modal resets to All Traffic and closes without posting', async ({ page }) => {
  const api = await openPage(page);
  const modal = page.getByRole('dialog', { name: 'Create Policy' });
  await pickRoute(page, 20, 40);
  await modal.getByRole('button', { name: 'DNS', exact: true }).click();
  await modal.getByRole('button', { name: 'All Traffic', exact: true }).click();
  await expect(modal).toContainText('Allow all traffic from lab to dmz.');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(page.getByText('No source selected')).toBeVisible();
  await settled(page);
  await pickRoute(page, 20, 40);
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toHaveCount(0);
  expect(api.take()).toEqual([]);
});

test('a policy is deleted from the list', async ({ page }) => {
  const api = await openPage(page);
  await expect(tab(page, 'Policies')).toContainText('(4)');
  await expect(page.getByText('servers-lab')).toBeVisible();
  await expect(row(page, 'Internet')).toContainText('ALL');
  await expect(row(page, 'Internet').getByRole('button')).toHaveCount(0);
  await expect(row(page, 'iot')).toContainText('deny');
  api.take();

  await row(page, 'dmz').getByRole('button').click();
  await confirmDelete(page, 'Delete this policy?');
  await expect.poll(() => api.calls.length).toBe(3);
  expect(api.take()).toEqual([
    { method: 'DELETE', url: '/admin/policies/14?firewallId=1' },
    { method: 'GET', url: '/admin/vlans' },
    { method: 'GET', url: '/admin/policies?firewallId=1' },
  ]);
});

test('a route shows a hover card and a popover that deletes its policy', async ({ page }) => {
  const api = await openPage(page);
  // Hover shows the route card; a click pins the popover with its delete action.
  const hit = page.locator('svg path[stroke="transparent"]').first();
  await hit.dispatchEvent('mouseover', { clientX: 500, clientY: 600 });
  await expect(page.getByText('Allowed traffic path')).toBeVisible();
  await hit.dispatchEvent('mouseout', { clientX: 500, clientY: 600 });
  await expect(page.getByText('Allowed traffic path')).toHaveCount(0);
  await hit.dispatchEvent('click', { clientX: 500, clientY: 600 });
  const deleteRoute = page.getByRole('button', { name: 'Delete this policy' });
  await expect(deleteRoute).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(deleteRoute).toHaveCount(0);
  await hit.dispatchEvent('click', { clientX: 500, clientY: 600 });
  await deleteRoute.click();
  await confirmDelete(page, 'Delete this policy?');
  await expect(deleteRoute).toHaveCount(0);
  await expect.poll(() => api.calls.length).toBe(3);
  expect(api.take()).toEqual([
    { method: 'DELETE', url: '/admin/policies/11?firewallId=1' },
    { method: 'GET', url: '/admin/vlans' },
    { method: 'GET', url: '/admin/policies?firewallId=1' },
  ]);
});

test('address objects are listed, created and deleted', async ({ page }) => {
  const api = await openPage(page);

  await tab(page, 'Address Objects').click();
  await expect(page.getByText('2 address objects')).toBeVisible();
  await expect(row(page, 'docs-site')).toContainText('docs.example.test');
  await expect(row(page, 'NET-10.10.0.0_24')).toContainText('ipmask');
  expect(api.take()).toEqual([
    { method: 'GET', url: '/admin/objects/addresses?firewallId=1' },
    { method: 'GET', url: '/admin/objects/services?firewallId=1' },
  ]);

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('Name (e.g. NET-10.10.5.0_24)').fill('NET-10.10.5.0_24');
  await page.getByPlaceholder('Subnet (e.g. 10.10.5.0 255.255.255.0)').fill('10.10.5.0 255.255.255.0');
  await page.getByPlaceholder('Comment (optional)').fill('lab subnet');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByPlaceholder('Comment (optional)')).toHaveCount(0);
  await row(page, 'docs-site').getByRole('button').click();
  await confirmDelete(page, 'Delete address object "docs-site"?');
  await expect.poll(() => api.calls.length).toBe(6);
  expect(api.take()).toEqual([
    { method: 'POST', url: '/admin/objects/addresses', body: { firewallId: 1, name: 'NET-10.10.5.0_24', subnet: '10.10.5.0 255.255.255.0', comment: 'lab subnet' } },
    { method: 'GET', url: '/admin/objects/addresses?firewallId=1' },
    { method: 'GET', url: '/admin/objects/services?firewallId=1' },
    { method: 'DELETE', url: '/admin/objects/addresses/docs-site?firewallId=1' },
    { method: 'GET', url: '/admin/objects/addresses?firewallId=1' },
    { method: 'GET', url: '/admin/objects/services?firewallId=1' },
  ]);

  // An open form survives a tab round trip.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('Comment (optional)').fill('kept');
  await tab(page, 'Policies').click();
  await expect(page.getByPlaceholder('Comment (optional)')).toHaveCount(0);
  await tab(page, 'Address Objects').click();
  await expect(page.getByPlaceholder('Comment (optional)')).toHaveValue('kept');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByPlaceholder('Comment (optional)')).toHaveCount(0);
});

test('service objects are listed, created and deleted', async ({ page }) => {
  const api = await openPage(page);
  await tab(page, 'Service Objects').click();
  await expect(page.getByText('2 service objects')).toBeVisible();
  await expect(row(page, 'Minecraft')).toContainText('TCP 25565');
  await expect(row(page, 'SIP')).toContainText('UDP 5060');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('Name', { exact: true }).fill('Plex');
  await page.getByPlaceholder('TCP ports (e.g. 8080)').fill('32400');
  await page.getByPlaceholder('UDP ports (e.g. 5060)').fill('32410-32414');
  await page.getByPlaceholder('Comment', { exact: true }).fill('media');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByPlaceholder('Comment', { exact: true })).toHaveCount(0);
  await row(page, 'SIP').getByRole('button').click();
  await confirmDelete(page, 'Delete service object "SIP"?');
  await expect.poll(() => api.calls.length).toBe(8);
  expect(api.take()).toEqual([
    { method: 'GET', url: '/admin/objects/addresses?firewallId=1' },
    { method: 'GET', url: '/admin/objects/services?firewallId=1' },
    { method: 'POST', url: '/admin/objects/services', body: { firewallId: 1, name: 'Plex', tcpPortrange: '32400', udpPortrange: '32410-32414', comment: 'media' } },
    { method: 'GET', url: '/admin/objects/addresses?firewallId=1' },
    { method: 'GET', url: '/admin/objects/services?firewallId=1' },
    { method: 'DELETE', url: '/admin/objects/services/SIP?firewallId=1' },
    { method: 'GET', url: '/admin/objects/addresses?firewallId=1' },
    { method: 'GET', url: '/admin/objects/services?firewallId=1' },
  ]);
});

test('a delegated policy manager sees only the policies tab', async ({ page }) => {
  const api = await mockPolicies(page, { user: delegate });
  await page.goto('/admin/policies');
  await expect(tab(page, 'Policies')).toContainText('(4)');
  await expect(tab(page, 'Address Objects')).toHaveCount(0);
  await expect(tab(page, 'Service Objects')).toHaveCount(0);
  expect(api.calls.some((call) => call.url.startsWith('/admin/objects'))).toBe(false);
});
