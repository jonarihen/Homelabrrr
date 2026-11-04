import { test, expect } from '@playwright/test';

// Admin Hardware power-policy panel against a fully mocked API: no PVE host,
// iLO or backend is contacted, and the test asserts exactly which writes the
// panel sends.
const admin = { id: 1, username: 'owner', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };
const connection = { id: 11, node_ref: '1~pve01', target_host: 'ilo.test', target_port: 443, username: 'operator', verify_tls: true,
  collection_enabled: true, control_enabled: false, last_status: 'ok', generation: 'Gen10', model: 'DL380', firmware: '2.80', config_version: 1,
  capabilities: { runtimeMode: 'supported', supportedModes: ['low', 'dynamic', 'high'], writePrivilege: 'confirmed' } };
const schedule = { enabled: true, timezone: 'Europe/Copenhagen', defaultMode: 'low', version: 1, windows: [
  { days: 0b0111110, start: '16:00', end: '02:00', mode: 'high' }, { days: 0b1000001, start: '12:00', end: '22:00', mode: 'high' }] };
const pricePolicy = { enabled: true, basis: 'variable_retail_including_vat', contractRef: '3', area: 'DK2', minAutomaticUpshiftMinutes: 5, version: 1,
  expensive: { enabled: true, threshold: '3.000000', hysteresis: '0.100000', capMode: 'dynamic' }, cheap: { enabled: false, threshold: '', hysteresis: '' } };
const record = (overrides = {}) => ({ controlEnabled: false, capability: 'supported', globalPaused: false, ...overrides,
  policy: { version: 4, automationEnabled: true, paused: false, driftHold: false, schedule, pricePolicy, lastVerifiedMode: 'low', lastOutcome: 'verified',
    manualMode: null, manualExpiresAt: null, ...overrides.policy } });
const preview = { at: '2026-10-12T13:59:00Z', draft: true, observedMode: 'low', baseMode: 'low', selectedMode: 'low', reason: 'disabled', priceStatus: 'valid',
  ifEnabled: { selectedMode: 'low', reason: 'schedule', baseMode: 'low' },
  sevenDayPreview: { nextScheduleTransition: '2026-10-12T14:00:00Z', nextKnownTransition: '2026-10-12T14:00:00Z', segments: [
    { startUtc: '2026-10-12T13:59:00Z', endUtc: '2026-10-12T14:00:00Z', baseMode: 'low', selectedMode: 'low', reason: 'schedule', priceStatus: 'valid', priceDkkPerKwh: '2.100000', futurePriceUnknown: false },
    { startUtc: '2026-10-12T14:00:00Z', endUtc: '2026-10-12T22:00:00Z', baseMode: 'high', selectedMode: 'dynamic', reason: 'price_high', priceStatus: 'valid', priceDkkPerKwh: '3.400000', futurePriceUnknown: false },
    { startUtc: '2026-10-12T22:00:00Z', endUtc: '2026-10-13T00:00:00Z', baseMode: 'high', selectedMode: null, reason: 'schedule', priceStatus: 'unavailable', priceDkkPerKwh: null, futurePriceUnknown: true }] } };

async function mockHosts(page, state = record()) {
  const writes = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') writes.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON?.() ?? null });
    return route.fulfill({ json: request.method() === 'GET' ? [] : {} });
  });
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/admin/pve-hosts', (route) => route.fulfill({ json: [{ id: 1, name: 'lab', host: 'pve.test', token_id: 'root@pam!t', verify_tls: true }] }));
  await page.route('**/api/admin/pve-hosts/1/status', (route) => route.fulfill({ json: { online: true, version: '9.0', vmCount: 0, runningVms: 0,
    nodes: [{ node: 'pve01', nodeRef: '1~pve01', status: 'online', cpu: 0.1, mem: 1, maxmem: 4 }] } }));
  await page.route('**/api/admin/hardware-connections', (route) => route.fulfill({ json: [connection] }));
  await page.route('**/api/admin/hardware-connections/11/telemetry**', (route) => route.fulfill({ json: { samples: [], energy: [], status: 'available' } }));
  await page.route('**/api/admin/power-control/11', (route) => {
    if (route.request().method() === 'PUT') { writes.push({ method: 'PUT', path: '/api/admin/power-control/11', body: route.request().postDataJSON() }); return route.fulfill({ json: state }); }
    return route.fulfill({ json: state });
  });
  await page.route('**/api/admin/power-control/11/preview', (route) => {
    if (route.request().method() === 'POST') writes.push({ method: 'POST', path: '/api/admin/power-control/11/preview', body: route.request().postDataJSON() });
    return route.fulfill({ json: preview });
  });
  return writes;
}

test('opening the hardware panel issues no writes and shows control disabled', async ({ page }) => {
  const writes = await mockHosts(page);
  await page.goto('/admin/hosts');
  await expect(page.getByText('Power policy', { exact: true })).toBeVisible();
  await expect(page.getByText('Control: disabled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disable live control' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply now' })).toBeDisabled();
  expect(writes).toEqual([]);
});

test('draft preview is read-only and marks periods after published prices unknown', async ({ page }) => {
  const writes = await mockHosts(page);
  await page.goto('/admin/hosts');
  await page.getByRole('button', { name: 'Preview draft' }).click();
  const timeline = page.getByRole('region', { name: 'Seven-day power mode preview' });
  await expect(timeline).toContainText('Unsaved draft');
  await expect(timeline.getByText('Unknown after published prices')).toBeVisible();
  await expect(timeline.getByText('price high')).toBeVisible();
  await expect(timeline).toContainText('If control and automation were enabled: Static Low Power (schedule)');
  expect(writes.map((item) => `${item.method} ${item.path}`)).toEqual(['POST /api/admin/power-control/11/preview']);
  expect(writes[0].body.pricePolicy.expensive.threshold).toBe('3.000000');
});

test('saving sends the edited policy with its version and does not enable live control', async ({ page }) => {
  const writes = await mockHosts(page);
  await page.goto('/admin/hosts');
  await page.getByLabel('Upper kr./kWh').fill('2,75');
  await page.getByRole('button', { name: 'Save policy' }).last().click();
  await expect(page.getByText(/Power policy saved\. Hardware changes still require separate enablement\./)).toBeVisible();
  const saves = writes.filter((item) => item.method === 'PUT');
  expect(saves).toHaveLength(1);
  expect(saves[0].body.version).toBe(4);
  expect(saves[0].body.pricePolicy.expensive.threshold).toBe('2,75');
  expect(writes.some((item) => /\/(enable|manual)$/.test(item.path))).toBe(false);
});

test('enabling live control requires explicit acknowledgement', async ({ page }) => {
  const writes = await mockHosts(page);
  await page.goto('/admin/hosts');
  await page.getByRole('button', { name: 'Enable live control' }).click();
  await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => writes.find((item) => item.path.endsWith('/enable'))).toBeTruthy();
  expect(writes.find((item) => item.path.endsWith('/enable')).body).toEqual({ acknowledgeLiveControl: true });
});
