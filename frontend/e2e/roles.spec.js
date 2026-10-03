import { test, expect } from '@playwright/test';

const admin = {
  id: 1, username: 'root', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {},
};

const baseRoles = [
  { id: 1, name: 'Administrator', description: 'all', builtIn: true, permissions: ['can_manage_users', 'can_operate_all_vms'], userCount: 1, max_cores: null, max_memory_gb: null, max_storage_gb: null },
  { id: 2, name: 'Operator', description: 'ops', builtIn: false, permissions: ['can_manage_vlans'], userCount: 2, max_cores: 8, max_memory_gb: null, max_storage_gb: null },
];

async function mockRoles(page, roles = baseRoles) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/admin/roles', (route) => route.fulfill({ json: { roles, permissionKeys: [] } }));
}

test('editing a role shows a review diff and impact before applying', async ({ page }) => {
  await mockRoles(page);
  let putBody = null;
  await page.route('**/api/admin/roles/2/users', (route) => route.fulfill({ json: [{ id: 3, username: 'alice' }, { id: 4, username: 'bob' }] }));
  await page.route('**/api/admin/roles/2', (route) => {
    putBody = route.request().postDataJSON();
    return route.fulfill({ json: { ...baseRoles[1] } });
  });
  await page.goto('/admin/roles');
  await page.getByRole('row', { name: /Operator/ }).getByRole('button', { name: 'Manage' }).click();
  await page.getByText('Operate all VMs').click();
  await page.getByRole('button', { name: 'Review 1 change' }).click();

  await expect(page.getByText(/This role currently has/)).toContainText('2');
  await expect(page.getByText('+ Operate all VMs')).toBeVisible();
  expect(putBody).toBeNull();

  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(() => putBody?.permissions?.sort()).toEqual(['can_manage_vlans', 'can_operate_all_vms']);
  expect(putBody.expectedHolders).toBe(2);
});

test('keyboard Review and Back refocus a reused role dialog without losing its original trigger', async ({ page }) => {
  await mockRoles(page);
  await page.route('**/api/admin/roles/2/users', (route) => route.fulfill({ json: [{ id: 3, username: 'alice' }, { id: 4, username: 'bob' }] }));
  await page.goto('/admin/roles');
  const trigger = page.getByRole('row', { name: /Operator/ }).getByRole('button', { name: 'Manage', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Role — Operator', exact: true });
  const titleId = await editor.getAttribute('aria-labelledby');
  const description = editor.getByRole('textbox').nth(1);
  await description.focus();
  await description.fill('Updated description');
  await expect(description).toBeFocused();
  await editor.getByRole('button', { name: 'Review 1 change', exact: true }).focus();
  await page.keyboard.press('Enter');
  const review = page.getByRole('dialog', { name: 'Review changes — Operator', exact: true });
  await expect(review).toBeVisible();
  expect(await review.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(await review.evaluate(() => document.activeElement.textContent)).toBe('Back');
  await expect(review.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
  expect(await review.getAttribute('aria-labelledby')).toBe(titleId);
  await page.keyboard.press('Enter');
  await expect(editor).toBeVisible();
  expect(await editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(await editor.evaluate(() => document.activeElement.value)).toBe('Operator');
  await expect(editor.getByRole('textbox').first()).toBeFocused();
  expect(await editor.getAttribute('aria-labelledby')).toBe(titleId);
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('clone posts to the clone endpoint with the chosen name', async ({ page }) => {
  await mockRoles(page);
  let cloneBody = null;
  await page.route('**/api/admin/roles/2/clone', (route) => {
    cloneBody = route.request().postDataJSON();
    return route.fulfill({ json: { ...baseRoles[1], id: 3, name: 'Operator Lite' } });
  });
  await page.goto('/admin/roles');
  await page.getByRole('row', { name: /Operator/ }).getByRole('button', { name: 'Clone' }).click();
  await page.getByPlaceholder('Operator (copy)').fill('Operator Lite');
  await page.getByRole('button', { name: 'Clone role' }).click();
  await expect.poll(() => cloneBody).toEqual({ name: 'Operator Lite' });
});

test('deleting a held role can reassign holders', async ({ page }) => {
  await mockRoles(page);
  await page.route('**/api/admin/roles/2/users', (route) => route.fulfill({ json: [{ id: 3, username: 'alice' }, { id: 4, username: 'bob' }] }));
  let deleteUrl = null;
  await page.route('**/api/admin/roles/2?**', (route) => {
    deleteUrl = route.request().url();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/admin/roles');
  await page.getByRole('row', { name: /Operator/ }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/user.*hold this role/)).toContainText('2');
  await page.getByRole('combobox').selectOption({ label: 'Administrator' });
  await page.getByRole('button', { name: 'Delete role' }).click();
  await expect.poll(() => deleteUrl).toContain('reassignTo=1');
  expect(deleteUrl).toContain('expectedHolders=2');
});

test('shared modal semantics, keyboard focus, dismissal and scroll restoration', async ({ page }) => {
  await mockRoles(page);
  await page.goto('/admin/roles');
  await page.evaluate(() => {
    document.body.style.setProperty('overflow-y', 'scroll', 'important');
    document.documentElement.style.setProperty('overflow-x', 'clip');
  });
  const trigger = page.getByRole('row', { name: /Operator/ }).getByRole('button', { name: 'Clone' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Clone — Operator', exact: true });
  const input = dialog.getByPlaceholder('Operator (copy)');
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const last = dialog.getByRole('button', { name: 'Clone role', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(await dialog.evaluate((element) => document.getElementById(element.getAttribute('aria-labelledby'))?.textContent)).toBe('Clone — Operator');
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => [document.body.style.overflowY, document.documentElement.style.overflowY])).toEqual(['hidden', 'hidden']);
  await expect(page.getByRole('main')).toHaveCSS('overflow-y', 'hidden');
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await trigger.evaluate((element) => element.focus());
  await expect(last).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => [
    document.body.style.overflowY, document.body.style.getPropertyPriority('overflow-y'),
    document.documentElement.style.overflowX, document.documentElement.style.overflowY,
  ])).toEqual(['scroll', 'important', 'clip', '']);
  await expect(page.getByRole('main')).toHaveCSS('overflow-y', 'auto');

  await trigger.click();
  await close.click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.locator('..').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('the filter narrows roles by permission label', async ({ page }) => {
  await mockRoles(page);
  await page.goto('/admin/roles');
  await page.getByLabel('Filter roles').fill('manage vlans');
  await expect(page.getByRole('row', { name: /Operator/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Administrator/ })).toHaveCount(0);
});

test('in-app navigation away from a dirty role editor asks first', async ({ page }) => {
  await mockRoles(page);
  await page.route('**/api/admin/audit-log**', (route) => route.fulfill({ json: { rows: [], total: 0, page: 1, limit: 50 } }));
  await page.goto('/admin/audit-log');
  await page.goto('/admin/roles');
  await page.getByRole('row', { name: /Operator/ }).getByRole('button', { name: 'Manage' }).click();
  await page.getByText('Manage PVE Hosts').click();

  let prompts = 0;
  page.on('dialog', (d) => { prompts += 1; d.dismiss(); });
  await page.evaluate(() => window.history.back());
  await expect.poll(() => prompts).toBe(1);
  await expect(page).toHaveURL(/\/admin\/roles$/);
  await expect(page.getByRole('button', { name: 'Review 1 change' })).toBeVisible();
});
