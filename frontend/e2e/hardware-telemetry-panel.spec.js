import { test, expect } from '@playwright/test';

// PVE Hosts → node → Hardware connection and telemetry panels against a fully
// mocked API: no PVE host, iLO or backend is contacted.
const admin = { id: 1, username: 'owner', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };
const member = { id: 7, username: 'member', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions: {} };
const nodes = [{ node: 'pve01', nodeRef: '1~pve01', status: 'online', cpu: 0.1, mem: 1, maxmem: 4 }, { node: 'pve03', nodeRef: '1~pve03', status: 'online', cpu: 0.1, mem: 1, maxmem: 4 }];
const base = { id: 11, node_ref: '1~pve01', target_host: '10.0.40.11', target_port: 443, username: 'monitor', verify_tls: false, tls_fingerprint: 'AB:'.repeat(31) + 'CD',
  has_ca_certificate: false, system_uuid: 'uuid-1', collection_enabled: true, control_enabled: false, last_status: 'online', generation: 'ilo5', model: 'DL380', firmware: '2.80',
  config_version: 1, capabilities: { monitoring: 'supported', runtimeMode: 'supported', temperatures: 'supported', fans: 'supported', powerSupplies: 'supported' } };
const health = { temperatures: [{ name: 'Inlet', celsius: 21 }], fans: [{ name: 'Fan 1', value: 30, unit: 'percent' }], powerSupplies: [{ name: 'PSU 1', health: 'OK' }] };
const latest = (overrides = {}) => ({ watts: '180', mode: 'dynamic', stale: false, ageSeconds: 30, health, ...overrides });
const telemetry = (overrides = {}) => ({ collectionEnabled: true, lastErrorCode: null, latest: latest(), stats: { samples: 0 }, summary: {}, points: [], modeChanges: [],
  range: { start: '2026-10-27T12:00:00Z', end: '2026-10-28T12:00:00Z', binSeconds: 900 }, ...overrides });

async function mockApi(page, { me = admin, connection = base, telemetryBody = telemetry() } = {}) {
  const writes = [];
  const hardwareRequests = [];
  let current = connection ? [connection] : [];
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/api/**', (route) => route.fulfill({ json: route.request().method() === 'GET' ? [] : {} }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: me }));
  await page.route('**/api/admin/pve-hosts', (route) => route.fulfill({ json: [{ id: 1, name: 'lab', host: 'pve.test', port: 8006, token_id: 'root@pam!t', verify_tls: true }] }));
  await page.route('**/api/admin/pve-hosts/1/status', (route) => route.fulfill({ json: { online: true, version: '9.0', vmCount: 0, runningVms: 0, nodes } }));
  await page.route('**/api/admin/hardware-connections**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    hardwareRequests.push(path);
    if (request.method() === 'GET') return route.fulfill({ json: path === '/api/admin/hardware-connections' ? current : telemetryBody });
    writes.push({ method: request.method(), path, body: request.postDataJSON?.() ?? null });
    if (path.endsWith('/rebind')) { current = [{ ...connection, node_ref: request.postDataJSON().nodeRef, config_version: 2, collection_enabled: false, last_status: 'not_tested' }]; return route.fulfill({ json: current[0] }); }
    return route.fulfill({ json: {} });
  });
  return { writes, hardwareRequests };
}

const panelState = (page) => page.locator('p[data-state]').first();

const states = [
  { name: 'offline', body: telemetry({ lastErrorCode: 'unreachable', latest: latest({ stale: true, ageSeconds: 1800 }) }), text: 'Offline · last reading 30 min old (unreachable)' },
  { name: 'stale', body: telemetry({ latest: latest({ stale: true, ageSeconds: 600 }) }), text: 'Stale · last reading 10 min old' },
  { name: 'unsupported', connection: { ...base, capabilities: { ...base.capabilities, monitoring: 'unsupported' } }, body: telemetry({ latest: null }), text: 'This iLO does not report actual input watts' },
  { name: 'online', body: telemetry(), text: 'Collecting' },
];

for (const { name, connection, body, text } of states) {
  test(`telemetry panel shows the ${name} state`, async ({ page }) => {
    await mockApi(page, { connection: connection || base, telemetryBody: body });
    await page.goto('/admin/hosts');
    await expect(panelState(page)).toHaveAttribute('data-state', name);
    await expect(panelState(page)).toHaveText(text);
    if (name === 'unsupported') await expect(page.getByText('Watt history unavailable on this iLO')).toBeVisible();
    if (name === 'offline') await expect(page.getByText('Unknown, not zero')).toHaveCount(0);
  });
}

test('partial sensor readings are labelled partial, not observed', async ({ page }) => {
  const partial = { ...health, temperatures: [{ name: 'Inlet', celsius: 21 }, { name: 'CPU 1', celsius: null }] };
  await mockApi(page, { telemetryBody: telemetry({ latest: latest({ health: partial }) }) });
  await page.goto('/admin/hosts');
  await expect(page.getByText('Temperatures · Partial readings')).toBeVisible();
  await expect(page.getByText('CPU 1: Reading unavailable')).toBeVisible();
  await expect(page.getByText('Fans · Observed')).toBeVisible();
});

test('an unverified, unpinned iLO shows the TLS-off warning', async ({ page }) => {
  await mockApi(page, { connection: { ...base, tls_fingerprint: null } });
  await page.goto('/admin/hosts');
  await expect(page.getByText(/TLS verification is OFF for this iLO/)).toBeVisible();
  await expect(page.getByText(/TLS NOT verified/)).toBeVisible();
});

test('a pinned iLO shows no TLS-off warning', async ({ page }) => {
  await mockApi(page);
  await page.goto('/admin/hosts');
  await expect(panelState(page)).toHaveText('Collecting');
  await expect(page.getByText(/TLS verification is OFF/)).toHaveCount(0);
});

test('rebind moves the iLO binding to another node with the current config version', async ({ page }) => {
  const { writes } = await mockApi(page);
  await page.goto('/admin/hosts');
  await page.getByRole('button', { name: 'Edit host lab' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Host' });
  const pve01 = dialog.locator('div.rounded-xl', { has: page.getByText('pve01', { exact: true }) });
  await pve01.getByLabel(/Rebind to node/).selectOption('1~pve03');
  await pve01.getByRole('button', { name: 'Rebind' }).click();
  await expect(pve01.getByText('not configured', { exact: true })).toBeVisible();
  const pve03 = dialog.locator('div.rounded-xl', { has: page.getByText('pve03', { exact: true }) });
  await expect(pve03.getByLabel('Management host')).toHaveValue('10.0.40.11');
  expect(writes).toEqual([{ method: 'POST', path: '/api/admin/hardware-connections/11/rebind', body: { nodeRef: '1~pve03', configVersion: 1 } }]);
});

test('members never see the hardware panel or load hardware data', async ({ page }) => {
  const { hardwareRequests } = await mockApi(page, { me: member });
  await page.goto('/admin/hosts');
  await expect(page).not.toHaveURL(/\/admin\/hosts/);
  await expect(page.getByText('Hardware / iLO')).toHaveCount(0);
  expect(hardwareRequests).toEqual([]);
});

test('a delegate without host management is denied before hardware data loads', async ({ page }) => {
  const { hardwareRequests } = await mockApi(page, { me: { ...member, permissions: { canManageUsers: true } } });
  await page.goto('/admin/hosts');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByText('Hardware / iLO')).toHaveCount(0);
  expect(hardwareRequests).toEqual([]);
});
