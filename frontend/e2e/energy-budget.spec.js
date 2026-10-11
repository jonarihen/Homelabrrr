import { test, expect } from '@playwright/test';

// Energy & Budget page against a mocked API only: no backend, iLO, meter or
// PayPal is contacted.
const member = { id: 7, username: 'friend', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions: {} };
const admin = { ...member, id: 1, username: 'owner', isAdmin: true };
const privateSentinels = ['payer-private@example.test', 'meter-secret-123', 'ilo-secret.internal', 'Contributor Alice'];

function summary(overrides = {}) {
  return {
    month: '2026-10', closed: false, snapshot: { consistent: true, attempts: 1 },
    telemetry: { status: 'measured', watts: 250, observedAt: '2026-10-08T12:00:00Z', kwh: 12.5, energyStatus: 'measured', coveragePercent: 100, monitoredHosts: 1, configuredHosts: 1 },
    price: { status: 'valid', orePerKwh: 245, basis: 'variable_retail_including_vat', validUntil: '2026-10-08T13:00:00Z' },
    cost: { status: 'calculated', actualOre: '25678', forecastOre: '40000', source: 'live_calculation', observedThrough: '2026-10-08T12:00:00Z',
      components: [{ key: 'server_variable', label: 'Measured server energy (purchase and variable charges)', ore: '25678', status: 'calculated' },
        { key: 'extra_variable', label: 'Estimated extra loads', ore: '0', status: 'estimated' },
        { key: 'fixed_fees', label: 'Allocated fixed fees', ore: '0', status: 'pending_month_end' }] },
    funding: { status: 'partial', grossOre: 15000, feeDebitsOre: 500, feeCreditsOre: 0, refundDebitsOre: 0, knownNetOre: 14500,
      openingCreditOre: null, eligibleNetOre: null, appliedOre: null, ownerFundedOre: null, ownerAdjustmentOre: null, carryForwardOre: null,
      unresolvedOre: 0, held: { pendingCount: 1, pendingOre: 2500, disputeCount: 0, disputedOre: 0 }, reconciledAt: '2026-10-08T12:00:00Z',
      progress: { status: 'estimate', basis: 'current_estimate', costOre: 25678, appliedOre: 14500, ownerRemainderOre: 11178, percent: 56.5 },
      payerEmail: privateSentinels[0], contributorName: privateSentinels[3] },
    household: { shared: false },
    meterId: privateSentinels[1], ...overrides,
  };
}
const emptyHistory = { from: '2026-10-07T12:00:00Z', through: '2026-10-08T12:00:00Z', points: [], energy: { points: [], binSeconds: 3600 }, modeChanges: [] };

async function mockEnergy(page, { values = summary(), hosts = { status: 'available', hosts: [] }, history = emptyHistory,
  preview = { hosts: [] }, months = { months: [] }, user = member, overview = null } = {}) {
  const writes = [];
  page.on('request', (request) => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
  await page.route('**/api/energy/summary?**', (route) => route.fulfill({ json: values }));
  await page.route('**/api/energy/hosts', (route) => route.fulfill({ json: hosts }));
  await page.route('**/api/energy/history**', (route) => route.fulfill({ json: history }));
  await page.route('**/api/energy/preview', (route) => route.fulfill({ json: preview }));
  await page.route('**/api/energy/months**', (route) => route.fulfill({ json: months }));
  if (overview) await page.route('**/api/energy/admin/overview', (route) => route.fulfill({ json: overview }));
  return writes;
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
  const writes = await mockEnergy(page, { hosts: { status: 'available', hosts: [{ alias: 'Server 01', stale: false, monitoring: 'enabled', observedMode: 'dynamic', watts: 250,
    ageSeconds: 30, reason: 'schedule', baseMode: 'dynamic', desiredMode: 'dynamic', managementHost: privateSentinels[2] }] } });
  await page.goto('/energy');
  await expect(page.getByRole('heading', { name: 'Energy & Budget' })).toBeVisible();
  await expect(page.getByText('Lab electricity cost').locator('..').locator('..')).toContainText('256,78');
  await expect(page.getByText('Gross contributions received').locator('..')).toContainText('150,00');
  await expect(page.getByRole('link', { name: /Optional contribution controls/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /iLO connections/ })).toHaveCount(0);
  await expect(page.getByText('The owner has not shared household electricity totals.')).toBeVisible();
  for (const sentinel of privateSentinels) await expect(page.getByText(sentinel)).toHaveCount(0);
  expect(writes, 'a page read never sends a write').toEqual([]);
});

test('funding progress renders from the server value with its basis, even when cost is a decimal string', async ({ page }) => {
  await mockEnergy(page);
  await page.goto('/energy');
  const bar = page.getByRole('progressbar');
  await expect(bar).toHaveAttribute('aria-valuenow', '56.5');
  await expect(page.getByText(/current estimate \(cost calculated so far\): 56,5% \(estimate/)).toBeVisible();
  await expect(page.getByText('Pending or disputed (not counted)').locator('..')).toContainText('1 open');
  await mockEnergy(page, { values: summary({ funding: { ...summary().funding, progress: { status: 'no_cost', basis: 'finalized_lab_cost', percent: null } } }) });
  await page.reload();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByText(/Funding progress is shown once/)).toBeVisible();
});

test('missing price and stale hardware display unknowns, coverage gaps and no invented zero', async ({ page }) => {
  const unknown = summary({
    telemetry: { status: 'unavailable', watts: null, observedAt: null, kwh: null, energyStatus: 'unavailable', coveragePercent: null },
    price: { status: 'incomplete', orePerKwh: null, basis: 'spot_only_excluding_retail_additions', validUntil: null },
    cost: { status: 'unavailable', actualOre: null, forecastOre: null, components: [] },
  });
  await mockEnergy(page, { values: unknown, hosts: { status: 'available', hosts: [{ alias: 'Server 01', stale: true, monitoring: 'degraded', observedMode: 'low', watts: 250, ageSeconds: 7200 }] } });
  await page.goto('/energy');
  await expect(page.getByText('Live server input').locator('..').locator('..')).toContainText('Unknown');
  await expect(page.getByText('Lab energy this month').locator('..').locator('..')).toContainText('Unknown');
  await expect(page.getByText('Electricity unit price').locator('..').locator('..')).toContainText('Unknown');
  await expect(page.getByText('Spot price only (tariffs, taxes and VAT excluded) · validity unavailable')).toBeVisible();
  await expect(page.getByText('Stale', { exact: true })).toBeVisible();
  await expect(page.getByText('No measured trend yet.')).toBeVisible();
  await expect(page.getByText('No integrated energy trend yet.')).toBeVisible();
  await expect(page.getByText('Month-end forecast unavailable')).toBeVisible();
});

test('mode reasons are explained in words and unpublished price periods are unknown', async ({ page }) => {
  await mockEnergy(page, {
    hosts: { status: 'available', hosts: [{ alias: 'Server 02', stale: false, monitoring: 'enabled', observedMode: 'dynamic', watts: 180, ageSeconds: 20,
      reason: 'price_high', baseMode: 'high', desiredMode: 'dynamic', priceValidUntil: '2026-10-08T12:15:00Z', priceRulesEnabled: true }] },
    preview: { hosts: [{ alias: 'Server 02', status: 'available', nextKnownChangeAt: '2026-10-08T12:15:00Z', nextKnownMode: 'high', priceKnownUntil: '2026-10-08T22:00:00Z', priceRulesEnabled: true,
      segments: [
        { startAt: '2026-10-08T12:00:00Z', endAt: '2026-10-08T12:15:00Z', baseMode: 'high', selectedMode: 'dynamic', reason: 'price_high', unknown: false, orePerKwh: 412 },
        { startAt: '2026-10-08T12:15:00Z', endAt: '2026-10-08T22:00:00Z', baseMode: 'high', selectedMode: 'high', reason: 'schedule', unknown: false, orePerKwh: 210 },
        { startAt: '2026-10-08T22:00:00Z', endAt: '2026-10-09T12:00:00Z', baseMode: 'low', selectedMode: null, reason: 'schedule', unknown: true, orePerKwh: null }] }] },
  });
  await page.goto('/energy');
  await expect(page.getByText('Dynamic: price exceeds the expensive-price limit until 14:15')).toBeVisible();
  await expect(page.getByText(/prices published until .*later periods are unknown/)).toBeVisible();
  await page.getByText('Server 02: next 24 hours').click();
  await expect(page.getByText('Unknown (price not published)')).toBeVisible();
  await expect(page.getByRole('button', { name: /Set mode|High|Low/ })).toHaveCount(0);
});

test('a shared household total is labeled as whole-household and kept apart from lab cost', async ({ page }) => {
  await mockEnergy(page, { values: summary({ household: { shared: true, basis: 'invoiced', status: 'available', totalOre: 150000, billKind: 'settlement', billStatus: 'partially_paid' } }) });
  await page.goto('/energy');
  await expect(page.getByText('Household invoice total').locator('..').locator('..')).toContainText('1.500,00');
  await expect(page.getByText(/covers the entire household, servers included; it is not added to the lab cost/)).toBeVisible();
});

test('history range selection asks only for the bounded seven-day series', async ({ page }) => {
  const ranges = [];
  await mockEnergy(page);
  await page.unroute('**/api/energy/history**');
  await page.route('**/api/energy/history**', (route) => {
    ranges.push(new URL(route.request().url()).searchParams.get('range'));
    return route.fulfill({ json: { ...emptyHistory, energy: { points: [], binSeconds: 7200 } } });
  });
  await page.goto('/energy');
  await page.getByRole('button', { name: '7d' }).click();
  await expect.poll(() => ranges.includes('7d')).toBe(true);
  await expect(page.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
});

test('keyboard navigation reaches month controls and monthly history; no horizontal scroll on a phone', async ({ page }) => {
  const asked = [];
  await mockEnergy(page, { months: { months: [{ month: '2026-09', open: false, kwh: 400, costStatus: 'finalized', costOre: 100000, grossOre: 10000, knownNetOre: 9600, appliedOre: 9600, ownerFundedOre: 90400, carryForwardOre: 0 }] } });
  await page.unroute('**/api/energy/summary?**');
  await page.route('**/api/energy/summary?**', (route) => { asked.push(new URL(route.request().url()).searchParams.get('month')); return route.fulfill({ json: summary() }); });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/energy');
  await page.getByRole('button', { name: 'Previous month' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => asked.length).toBeGreaterThan(1);
  await expect(page.getByRole('cell', { name: '904,00 kr.' })).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('administrator panel shows setup links and health; sharing needs identity confirmation', async ({ page }) => {
  const overview = { householdShare: 'off',
    hardware: { status: 'configured', active: 2, decommissioned: 1, collecting: 2, degraded: 0, stale: 1, controlEnabled: 1, automationEnabled: 1, pausedOrHeld: 0 },
    meter: { status: 'enabled', scope: 'household', lastSuccessAt: '2026-10-08T10:00:00Z', earliestIntervalStart: '2026-01-01T00:00:00Z', latestIntervalEnd: '2026-10-07T00:00:00Z', gapCount: 2, skippedRangeCount: 0, chargesAvailable: true },
    bills: { due: 1, partiallyPaid: 0, paid: 4 },
    paypal: { health: { status: 'ok', lastSuccessAt: '2026-10-08T11:00:00Z', unresolvedTransactions: 1, reviewEvents: 0, pendingInboxEvents: 0, uncertainCaptures: 0, failingSubscriptions: 0, cancellationsAwaitingConfirmation: 0 },
      contributions: { grossOre: 10000, feeDebitsOre: -400, refundDebitsOre: 0, knownNetOre: 9600 }, subscriptions: { ACTIVE: 2 } } };
  const puts = [];
  let reauthenticated = false;
  await mockEnergy(page, { user: admin, overview });
  await page.route('**/api/auth/reauthenticate', (route) => { reauthenticated = true; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/energy/admin/household-share', (route) => {
    puts.push(route.request().postDataJSON());
    return reauthenticated ? route.fulfill({ json: { householdShare: 'paid' } })
      : route.fulfill({ status: 403, json: { error: 'Please confirm', code: 'REAUTHENTICATION_REQUIRED' } });
  });
  await page.goto('/energy');
  await expect(page.getByRole('heading', { name: 'Administrator: setup & coverage' })).toBeVisible();
  for (const name of [/iLO connections/, /Power policies/, /ElOverblik meter/, /Contract, prices & bills/, /PayPal setup/]) await expect(page.getByRole('link', { name })).toBeVisible();
  await expect(page.getByText('Unknown-net payments').locator('..')).toContainText('1');
  await expect(page.getByLabel('Not shared (default)')).toBeChecked();
  await page.getByLabel('Share monthly household amount paid').click();
  await expect(page.getByRole('dialog', { name: 'Confirm your identity' })).toBeVisible();
  await page.getByPlaceholder('Current password').fill('fixture-password');
  await page.getByRole('button', { name: 'Confirm & continue' }).click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts).toEqual([{ mode: 'paid' }, { mode: 'paid' }]);
  await expect(page.getByText('Household total sharing saved.')).toBeVisible();
});
