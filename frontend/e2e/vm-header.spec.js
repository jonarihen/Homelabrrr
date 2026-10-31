import { test, expect } from '@playwright/test';

async function mockVm(context, discover, status = 'running') {
  await context.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      return route.fulfill({ json: { id: 7, username: 'operator', isAdmin: false, twoFactorEnabled: true, permissions: {} } });
    }
    if (path.endsWith('/status')) return route.fulfill({ json: { node: 'pve', nodeRef: '2~pve', vmid: 101, name: 'Test VM', status } });
    if (path.endsWith('/detected-ips')) return discover(route);
    if (path.endsWith('/config') || path.includes('/ssh/config/')) return route.fulfill({ json: {} });
    if (path.endsWith('/ip-management')) return route.fulfill({ json: { interfaces: [] } });
    return route.fulfill({ json: [] });
  });
}

test('IP discovery retries errors and empty results while booting, then stops after success', async ({ page, context }) => {
  let requests = 0;
  await mockVm(context, route => {
    requests += 1;
    if (requests === 1) return route.fulfill({ status: 503, json: { error: 'Guest agent not ready' } });
    return route.fulfill({ json: { candidates: requests < 3 ? [] : [{ ip: '192.0.2.101' }] } });
  });
  await page.clock.install();
  await page.goto('/vm/2~pve/101');
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByRole('button', { name: /Copy IP address/ })).toHaveCount(0);
  await page.clock.runFor(15100);
  await expect.poll(() => requests).toBe(2);
  await page.clock.runFor(15100);
  await expect(page.getByRole('button', { name: 'Copy IP address 192.0.2.101' })).toBeVisible();
  await page.clock.runFor(60000);
  expect(requests).toBe(3);
});

test('IP discovery is bounded and does not retry stopped VMs', async ({ page, context }) => {
  let requests = 0;
  await mockVm(context, route => {
    requests += 1;
    return route.fulfill({ json: { candidates: [] } });
  });
  await page.clock.install();
  await page.goto('/vm/2~pve/101');
  await expect.poll(() => requests).toBe(1);
  for (let i = 2; i <= 20; i += 1) {
    await page.clock.runFor(15100);
    await expect.poll(() => requests).toBe(i);
  }
  await page.clock.runFor(60000);
  expect(requests).toBe(20);
  await page.unrouteAll({ behavior: 'wait' });
  await mockVm(context, route => {
    requests += 1;
    return route.fulfill({ json: { candidates: [] } });
  }, 'stopped');
  await page.reload();
  await expect.poll(() => requests).toBe(21);
  await page.clock.runFor(60000);
  expect(requests).toBe(21);
});

test('VM navigation clears the previous IP and ignores late discovery responses', async ({ page, context }) => {
  let oldRequest;
  let requests = 0;
  await mockVm(context, route => {
    requests += 1;
    if (route.request().url().includes('/101/')) {
      if (requests === 1) return route.fulfill({ json: { candidates: [{ ip: '192.0.2.101' }] } });
      oldRequest = route;
      return;
    }
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/vm/2~pve/101');
  await expect(page.getByRole('button', { name: 'Copy IP address 192.0.2.101' })).toBeVisible();
  const navigate = vmid => page.evaluate(id => {
    history.pushState({}, '', `/vm/2~pve/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, vmid);
  await navigate(102);
  await expect(page.getByRole('button', { name: /Copy IP address/ })).toHaveCount(0);
  await navigate(101);
  await expect.poll(() => !!oldRequest).toBe(true);
  await navigate(103);
  await expect.poll(() => requests).toBe(4);
  await oldRequest.fulfill({ json: { candidates: [{ ip: '192.0.2.199' }] } });
  await expect(page.getByRole('button', { name: /Copy IP address/ })).toHaveCount(0);
});

test('section links focus the target with a visible focus ring', async ({ page, context }) => {
  await mockVm(context, route => route.fulfill({ json: { candidates: [] } }));
  await page.goto('/vm/2~pve/101');
  const link = page.getByRole('link', { name: 'Snapshots' });
  await link.focus();
  await page.keyboard.press('Enter');
  const target = page.locator('#vm-snapshots');
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS('box-shadow', /rgb\(255, 122, 68\)/);
  await expect(page).toHaveURL(/#vm-snapshots$/);
});
