import { test, expect } from '@playwright/test';

const user = (permissions) => ({
  id: 7, username: 'operator', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions,
});

async function mockUsersPageData(page) {
  await page.route('**/api/admin/vms', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/vlans', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/roles', (route) => route.fulfill({ json: { roles: [], permissionKeys: [] } }));
  await page.route('**/api/admin/invites', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/user-usage', (route) => route.fulfill({ json: {} }));
}

test('a user can sign in and reach the authenticated welcome flow', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/auth/login', (route) => route.fulfill({ json: user({}) }));
  await page.route('**/api/portal/status', (route) => route.fulfill({ json: { overall: 'operational', hostsOnline: 1, hostsTotal: 1 } }));
  await page.route('**/api/vms', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/portal/notices**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/portal/links', (route) => route.fulfill({ json: [] }));
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill('operator');
  await page.locator('input[autocomplete="current-password"]').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, operator' })).toBeVisible();
});

test('a direct admin URL is blocked before unauthorized page data loads', async ({ page }) => {
  let usersApiRequested = false;
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user({ canManageHosts: true }) }));
  await page.route('**/api/admin/users', (route) => { usersApiRequested = true; return route.fulfill({ json: [] }); });
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(usersApiRequested).toBe(false);
});

test('a delegated user can open the matching admin route', async ({ page }) => {
  await mockUsersPageData(page);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user({ canManageUsers: true }) }));
  await page.route('**/api/admin/users', (route) => route.fulfill({ json: [] }));
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  const primary = page.getByRole('button', { name: '+ New User', exact: true });
  await primary.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(primary).toBeFocused();
  await expect(primary).toHaveCSS('outline-color', 'rgb(233, 236, 239)');
  await expect(primary).toHaveCSS('outline-width', '2px');
  await expect(primary).toHaveCSS('outline-offset', '2px');
});

test('refresh applies a permission change before protected page data is requested', async ({ page }) => {
  await mockUsersPageData(page);
  let canManageUsers = true;
  let usersRequests = 0;
  let usageRequests = 0;
  // Keep one unrelated admin-area permission so revoking canManageUsers tests
  // the per-route guard instead of the parent guard redirecting to Dashboard.
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user({ canManageUsers, canManageHosts: true }) }));
  await page.route('**/api/admin/users', (route) => { usersRequests += 1; return route.fulfill({ json: [] }); });
  await page.route('**/api/admin/user-usage', (route) => { usageRequests += 1; return route.fulfill({ json: {} }); });
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  // React StrictMode mounts the authorized page twice in development, so it
  // issues two /admin/users requests that reach this test as separate
  // route-handler calls. Snapshotting after the first one races the second.
  // Each load requests /admin/user-usage only after its own /admin/users
  // call, and the browser reports requests in order, so once a usage request
  // is seen every authorized users request has already been counted.
  await expect.poll(() => usageRequests).toBeGreaterThan(0);
  const authorizedRequestCount = usersRequests;
  canManageUsers = false;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(usersRequests).toBe(authorizedRequestCount);
});
