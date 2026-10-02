import { test, expect } from '@playwright/test';

const admin = {
  id: 1, username: 'root', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {},
};

const target = {
  id: 5, username: 'alice', is_admin: false, role_id: null, role_name: null, vm_count: 0,
  see_all_vms: false, can_operate_all_vms: false, created_at: '2026-01-01T00:00:00Z',
};

const state = {
  id: 5, username: 'alice', is_admin: false, version: 'v1', role_id: null,
  permissions: { see_all_vms: false, can_operate_all_vms: false, can_provision: false, can_create_vms: false, can_manage_hosts: false },
  require_2fa: false,
  quotas: { max_cores: null, max_memory_gb: null, max_storage_gb: null },
  vms: [],
  vlan_ids: [],
};

async function mockUsersPage(page, { onPatch, onLegacyWrite } = {}) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/admin/users', (route) => route.fulfill({ json: [target] }));
  await page.route('**/api/admin/vms', (route) => route.fulfill({ json: [{ vmid: 101, node: 'pve', nodeRef: '1~pve', name: 'web', status: 'running' }] }));
  await page.route('**/api/admin/vlans', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/roles', (route) => route.fulfill({ json: { roles: [], permissionKeys: [] } }));
  await page.route('**/api/admin/invites', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/user-usage', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/admin/users/5/state', (route) => route.fulfill({ json: state }));
  await page.route('**/api/admin/users/5', (route) => {
    if (route.request().method() === 'PATCH') return onPatch ? onPatch(route) : route.fulfill({ json: state });
    return route.fallback();
  });
  await page.route(/\/api\/admin\/(users\/5\/(permission|see-all-vms|can-provision|require-2fa|role)|assignments)/, (route) => {
    onLegacyWrite?.(route.request().url());
    return route.fulfill({ json: { ok: true } });
  });
}

test('toggles are staged and only sent after review and username confirmation', async ({ page }) => {
  let patchBody = null;
  const legacy = [];
  await mockUsersPage(page, {
    onPatch: (route) => {
      patchBody = route.request().postDataJSON();
      return route.fulfill({ json: { ...state, version: 'v2', permissions: { ...state.permissions, can_operate_all_vms: true } } });
    },
    onLegacyWrite: (url) => legacy.push(url),
  });
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Manage' }).click();

  await page.getByText('Operate all VMs').click();
  await page.getByText('Manage PVE Hosts').click();
  await expect(page.getByText('2 pending changes')).toBeVisible();

  await page.getByRole('button', { name: 'VM Assignments' }).click();
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('pending add')).toBeVisible();
  await expect(page.getByText('3 pending changes')).toBeVisible();

  expect(patchBody).toBeNull();
  expect(legacy).toEqual([]);

  await page.getByRole('button', { name: 'Review & Apply' }).click();
  await expect(page.getByText('+ Operate all VMs')).toBeVisible();
  const apply = page.getByRole('button', { name: 'Apply 3 changes' });
  await expect(apply).toBeDisabled();
  await page.getByLabel('Confirm username').fill('alice');
  await apply.click();

  await expect.poll(() => patchBody).toEqual({
    version: 'v1',
    permissions: { can_operate_all_vms: true, can_manage_hosts: true },
    vms: { add: [{ node: '1~pve', vmid: 101 }], remove: [] },
  });
  expect(legacy).toEqual([]);
});

test('discard drops staged edits without any request', async ({ page }) => {
  let patched = false;
  await mockUsersPage(page, { onPatch: (route) => { patched = true; return route.fulfill({ json: state }); } });
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByText('Manage PVE Hosts').click();
  await expect(page.getByText('1 pending change')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText(/pending change/)).toHaveCount(0);
  expect(patched).toBe(false);
});

test('a 409 conflict reloads the latest state and reports it', async ({ page }) => {
  await mockUsersPage(page, {
    onPatch: (route) => route.fulfill({ status: 409, json: { error: 'This user was changed by someone else.' } }),
  });
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByText('Manage PVE Hosts').click();
  await page.getByRole('button', { name: 'Review & Apply' }).click();
  await page.getByRole('button', { name: 'Apply 1 change' }).click();
  await expect(page.getByText(/changed by someone else/)).toBeVisible();
  await expect(page.getByText(/pending change/)).toHaveCount(0);
});

test('browser Back asks before discarding staged user changes', async ({ page }) => {
  await mockUsersPage(page);
  await page.route('**/api/admin/audit-log**', (route) => route.fulfill({ json: { rows: [], total: 0, page: 1, limit: 50 } }));
  await page.goto('/admin/audit-log');
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByText('Manage PVE Hosts').click();

  let prompts = 0;
  page.on('dialog', (d) => { prompts += 1; d.dismiss(); });
  await page.evaluate(() => window.history.back());
  await expect.poll(() => prompts).toBe(1);
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByText('1 pending change')).toBeVisible();
});
