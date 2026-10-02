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
  await page.route('**/api/admin/roles/2', (route) => {
    putBody = route.request().postDataJSON();
    return route.fulfill({ json: { ...baseRoles[1] } });
  });
  await page.goto('/admin/roles');
  await page.getByRole('row', { name: /Operator/ }).getByRole('button', { name: 'Manage' }).click();
  await page.getByText('Operate all VMs').click();
  await page.getByRole('button', { name: 'Review 1 change' }).click();

  await expect(page.getByText(/changes effective permissions for/)).toContainText('2');
  await expect(page.getByText('+ Operate all VMs')).toBeVisible();
  expect(putBody).toBeNull();

  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(() => putBody?.permissions?.sort()).toEqual(['can_manage_vlans', 'can_operate_all_vms']);
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
});

test('the filter narrows roles by permission label', async ({ page }) => {
  await mockRoles(page);
  await page.goto('/admin/roles');
  await page.getByLabel('Filter roles').fill('manage vlans');
  await expect(page.getByRole('row', { name: /Operator/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Administrator/ })).toHaveCount(0);
});
