import { test, expect } from '@playwright/test';

// iLO settings live in the Edit Host dialog. Fully mocked API: no PVE host or
// iLO is contacted, and the test asserts exactly which writes are sent.
const admin = { id: 1, username: 'owner', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };
const host = { id: 1, name: 'lab', host: 'pve.test', port: 8006, token_id: 'root@pam!t', verify_tls: true };
const nodes = [{ node: 'pve01', nodeRef: '1~pve01', status: 'online', cpu: 0.1, mem: 1, maxmem: 4 }, { node: 'pve03', nodeRef: '1~pve03', status: 'online', cpu: 0.1, mem: 1, maxmem: 4 }];
const saved = { id: 11, node_ref: '1~pve01', target_host: '10.0.40.11', target_port: 443, username: 'monitor', verify_tls: false, has_ca_certificate: false,
  collection_enabled: false, control_enabled: false, last_status: 'not_tested', generation: null, model: null, firmware: null, config_version: 1, capabilities: null };

async function mockApi(page, { connections = [] } = {}) {
  const writes = [];
  let current = connections;
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/api/**', (route) => route.fulfill({ json: route.request().method() === 'GET' ? [] : {} }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/admin/pve-hosts', (route) => route.fulfill({ json: [host] }));
  await page.route('**/api/admin/pve-hosts/1/status', (route) => route.fulfill({ json: { online: true, version: '9.0', vmCount: 0, runningVms: 0, nodes } }));
  await page.route('**/api/admin/hardware-connections**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/admin/hardware-connections') return route.fulfill({ json: current });
    if (request.method() === 'GET') return route.fulfill({ json: { samples: [], energy: [], status: 'available' } });
    writes.push({ method: request.method(), path, body: request.postDataJSON?.() ?? null });
    if (path.endsWith('/test')) return route.fulfill({ status: 502, json: { status: 'unreachable', code: 'unreachable', detail: 'connection refused — nothing is listening on that port (ECONNREFUSED)', error: 'iLO connection test failed (unreachable)' } });
    if (request.method() === 'POST') { current = [saved]; return route.fulfill({ status: 201, json: saved }); }
    if (request.method() === 'PUT') { current = [{ ...saved, ...{ target_host: request.postDataJSON().host, config_version: 2 } }]; return route.fulfill({ json: current[0] }); }
    return route.fulfill({ json: {} });
  });
  return writes;
}

test('the node row points to Edit Host instead of carrying its own iLO form', async ({ page }) => {
  await mockApi(page);
  await page.goto('/admin/hosts');
  await expect(page.getByText('not configured — add it under Edit Host').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Configure' })).toHaveCount(0);
  await expect(page.getByLabel('Management host')).toHaveCount(0);
});

test('Edit Host configures an iLO per node and keeps it editable after saving', async ({ page }) => {
  const writes = await mockApi(page);
  await page.goto('/admin/hosts');
  await page.getByRole('button', { name: 'Edit host lab' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Host' });
  await expect(dialog.getByText('Hardware / iLO', { exact: true })).toBeVisible();
  const pve01 = dialog.locator('div.rounded-xl', { has: page.getByText('pve01', { exact: true }) });
  await expect(dialog.getByLabel('Management host')).toHaveCount(2);
  await pve01.getByLabel('Management host').fill('10.0.40.11');
  await pve01.getByLabel('Username').fill('monitor');
  await pve01.getByLabel(/^Password/).fill('fixture-password');
  await pve01.getByRole('button', { name: 'Add iLO connection' }).click();
  await expect(pve01.getByText(/^Saved\./)).toBeVisible();
  // Still editable: the saved values are in the form and a second save is a PUT.
  await expect(pve01.getByLabel('Management host')).toHaveValue('10.0.40.11');
  await pve01.getByLabel('Management host').fill('10.0.40.12');
  await pve01.getByLabel(/^Password/).fill('fixture-password');
  await pve01.getByRole('button', { name: 'Save iLO changes' }).click();
  await expect(pve01.getByLabel('Management host')).toHaveValue('10.0.40.12');
  expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /api/admin/hardware-connections', 'PUT /api/admin/hardware-connections/11']);
  expect(writes[0].body).toMatchObject({ nodeRef: '1~pve01', host: '10.0.40.11', username: 'monitor' });
  expect(writes[1].body).toMatchObject({ host: '10.0.40.12', configVersion: 1 });
});

test('a failed read-only test shows why the iLO could not be reached', async ({ page }) => {
  await mockApi(page, { connections: [saved] });
  await page.goto('/admin/hosts');
  await page.getByRole('button', { name: 'Test read-only connection' }).first().click();
  await expect(page.getByRole('alert').filter({ hasText: 'ECONNREFUSED' })).toContainText('Connection test failed: Unreachable — connection refused');
});
