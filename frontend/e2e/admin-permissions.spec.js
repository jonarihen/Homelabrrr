import { test, expect } from '@playwright/test';

const user = (permissions) => ({
  id: 7, username: 'operator', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions,
});

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
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user({ canManageUsers: true }) }));
  await page.route('**/api/admin/users', (route) => route.fulfill({ json: [] }));
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
});

test('refresh applies a permission change before protected page data is requested', async ({ page }) => {
  let canManageUsers = true;
  let usersRequests = 0;
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user({ canManageUsers }) }));
  await page.route('**/api/admin/users', (route) => { usersRequests += 1; return route.fulfill({ json: [] }); });
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  expect(usersRequests).toBe(1);
  canManageUsers = false;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(usersRequests).toBe(1);
});
