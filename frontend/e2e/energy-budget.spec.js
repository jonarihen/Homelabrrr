import { test, expect } from '@playwright/test';

const member = { id: 7, username: 'friend', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions: {} };
const privateSentinels = ['payer-private@example.test', 'meter-secret-123', 'ilo-secret.internal', 'Contributor Alice'];

function summary(overrides = {}) {
  return {
    telemetry: { status: 'measured', watts: 250, observedAt: '2026-10-08T12:00:00Z', kwh: 12.5, energyStatus: 'measured', coveragePercent: 100 },
    price: { status: 'valid', orePerKwh: 245, basis: 'applicable_total', validUntil: '2026-10-08T13:00:00Z' },
    cost: { status: 'calculated', actualOre: '25678', forecastOre: '40000' },
    funding: { grossOre: 15000, feeDebitsOre: 500, feeCreditsOre: 0, refundDebitsOre: 0, knownNetOre: 14500,
      eligibleNetOre: 14500, appliedOre: 14500, ownerFundedOre: 11178, ownerAdjustmentOre: 0, carryForwardOre: 0,
      unresolvedOre: 0, reconciledAt: '2026-10-08T12:00:00Z', payerEmail: privateSentinels[0], contributorName: privateSentinels[3] },
    meterId: privateSentinels[1], ...overrides,
  };
}

async function mockEnergy(page, values = summary(), hosts = { status: 'available', hosts: [] }, history = { points: [], energy: { points: [], binSeconds: 3600 } }) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: member }));
  await page.route('**/api/energy/summary**', (route) => route.fulfill({ json: values }));
  await page.route('**/api/energy/hosts', (route) => route.fulfill({ json: hosts }));
  await page.route('**/api/energy/history**', (route) => route.fulfill({ json: history }));
}

test('direct anonymous access redirects before any private energy request', async ({ page }) => {
  let privateRequests = 0;
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/energy/**', (route) => { privateRequests += 1; return route.fulfill({ status: 401, json: { error: 'Unauthorized' } }); });
  await page.goto('/energy');
  await expect(page).toHaveURL(/\/login$/);
  expect(privateRequests).toBe(0);
});

test('authenticated member sees aggregate funding and calculated cost without contributor or infrastructure identifiers', async ({ page }) => {
  await mockEnergy(page, summary(), { status: 'available', hosts: [{ alias: 'Server 01', stale: false, monitoring: 'enabled', observedMode: 'dynamic', watts: 250,
    ageSeconds: 30, reason: 'schedule', managementHost: privateSentinels[2] }] });
  await page.goto('/energy');
  await expect(page.getByRole('heading', { name: 'Energy & Budget' })).toBeVisible();
  await expect(page.getByText('Lab electricity cost').locator('..').locator('..')).toContainText('256,78');
  await expect(page.getByText('Gross contributions received').locator('..')).toContainText('150,00');
  await expect(page.getByRole('link', { name: /Optional contribution controls/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /iLO & telemetry/ })).toHaveCount(0);
  for (const sentinel of privateSentinels) await expect(page.getByText(sentinel)).toHaveCount(0);
});

test('missing price and stale hardware display unknowns, coverage gaps and no invented zero', async ({ page }) => {
  const unknown = summary({
    telemetry: { status: 'unavailable', watts: null, observedAt: null, kwh: null, energyStatus: 'unavailable', coveragePercent: null },
    price: { status: 'incomplete', orePerKwh: null, basis: 'spot_with_tariffs', validUntil: null },
    cost: { status: 'unavailable', actualOre: null, forecastOre: null },
  });
  await mockEnergy(page, unknown, { status: 'available', hosts: [{ alias: 'Server 01', stale: true, monitoring: 'degraded', observedMode: 'low', watts: 250, ageSeconds: 7200 }] });
  await page.goto('/energy');
  await expect(page.getByText('Live server input').locator('..').locator('..')).toContainText('Unknown');
  await expect(page.getByText('Lab energy this month').locator('..').locator('..')).toContainText('Unknown');
  await expect(page.getByText('Electricity unit price').locator('..').locator('..')).toContainText('Unknown');
  await expect(page.getByText('spot_with_tariffs · validity unavailable')).toBeVisible();
  await expect(page.getByText('Stale', { exact: true })).toBeVisible();
  await expect(page.getByText('No measured trend yet.')).toBeVisible();
  await expect(page.getByText('No integrated energy trend yet.')).toBeVisible();
  await expect(page.getByText('Month-end forecast unavailable')).toBeVisible();
});

test('history range selection asks only for the bounded seven-day series', async ({ page }) => {
  const ranges = [];
  await mockEnergy(page);
  await page.unroute('**/api/energy/history**');
  await page.route('**/api/energy/history**', (route) => {
    ranges.push(new URL(route.request().url()).searchParams.get('range'));
    return route.fulfill({ json: { points: [], energy: { points: [], binSeconds: 7200 } } });
  });
  await page.goto('/energy');
  await page.getByRole('button', { name: '7d' }).click();
  await expect.poll(() => ranges.includes('7d')).toBe(true);
  await expect(page.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
});
