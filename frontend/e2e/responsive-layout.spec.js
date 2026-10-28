import { test, expect } from '@playwright/test';

// Phone-width shell with a mocked API only: no backend is contacted.
const admin = { id: 1, username: 'root', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };
const vms = [{
  vmid: 101, name: 'a-rather-long-virtual-machine-name-for-wrapping', node: '1~pve', status: 'running',
  cpu: 0.12, maxcpu: 4, mem: 2147483648, maxmem: 8589934592, maxdisk: 34359738368, uptime: 3600, tags: 'owner-root',
}];
const roles = [{ id: 2, name: 'Operator', description: 'ops', builtIn: false, permissions: ['can_manage_vlans'], userCount: 2, max_cores: 8, max_memory_gb: null, max_storage_gb: null }];

test.use({ viewport: { width: 375, height: 740 } });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/vms', (route) => route.fulfill({ json: vms }));
  await page.route('**/api/admin/roles', (route) => route.fulfill({ json: { roles, permissionKeys: [] } }));
});

// The shell clips the document, so the scrolling <main> must be checked too.
const noHorizontalScroll = (page) => page.evaluate(() => (
  Math.max(document.documentElement.scrollWidth, document.querySelector('main').scrollWidth) <= window.innerWidth
));

test('the navigation drawer opens and closes with the keyboard at phone width', async ({ page }) => {
  await page.goto('/dashboard');
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'My VMs' })).toBeHidden();

  await menu.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();

  // Following a link closes the drawer.
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: 'Roles' }).click();
  await expect(page).toHaveURL(/\/admin\/roles$/);
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
});

test('the dashboard does not scroll horizontally at phone width', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByText(vms[0].name).first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('an admin table page does not scroll horizontally at phone width', async ({ page }) => {
  await page.goto('/admin/roles');
  await expect(page.getByRole('row', { name: /Operator/ })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('the drawer and its backdrop sit above console windows and below app modals', async ({ page }) => {
  await page.route('**/api/vms/2~pve/101/status', (route) => route.fulfill({ json: { node: 'pve', nodeRef: '2~pve', vmid: 101, name: 'Test VM', status: 'running' } }));
  await page.route('**/api/vms/2~pve/101/vnc-ticket', (route) => route.fulfill({ status: 503, json: { error: 'Test console offline' } }));
  await page.goto('/vm/2~pve/101');
  await page.getByRole('button', { name: 'VNC', exact: true }).click();
  await expect(page.getByText('Test console offline')).toBeVisible();

  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();

  const z = await page.evaluate(() => {
    const drawer = document.getElementById('app-sidebar');
    const backdrop = drawer.previousElementSibling;
    return { drawer: getComputedStyle(drawer).zIndex, backdrop: getComputedStyle(backdrop).zIndex };
  });
  expect(Number(z.backdrop)).toBeGreaterThan(40); // console portal layer
  expect(Number(z.drawer)).toBeGreaterThan(Number(z.backdrop));
  expect(Number(z.drawer)).toBeLessThan(50); // app modals stay on top

  // A tap on the console area must hit the backdrop and dismiss the drawer,
  // not land on the console window behind it.
  const box = await page.locator('div.pointer-events-auto').filter({ hasText: 'Test console offline' }).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
  await expect(page.getByText('Test console offline')).toBeVisible();
});
