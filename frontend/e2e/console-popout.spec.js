import { test, expect } from '@playwright/test';

const vm = { node: 'pve', nodeRef: '2~pve', vmid: 101, name: 'Lab console & tools / #1', status: 'running' };

async function mockConsoleData(context) {
  await context.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      return route.fulfill({ json: { id: 7, username: 'operator', isAdmin: false, twoFactorEnabled: true, permissions: {} } });
    }
    if (path.endsWith('/status')) return route.fulfill({ json: vm });
    if (path.endsWith('/config') || path.includes('/ssh/config/')) return route.fulfill({ json: {} });
    if (path.endsWith('/ip-management')) return route.fulfill({ json: { interfaces: [] } });
    if (path.endsWith('/vnc-ticket')) return route.fulfill({ status: 503, json: { error: 'Test console offline' } });
    return route.fulfill({ json: [] });
  });
}

for (const type of ['VNC', 'SSH']) {
  test(`${type} pop-out opens once in StrictMode, severs the opener and removes only its session`, async ({ page, context }) => {
    await mockConsoleData(context);
    await page.addInitScript(() => {
      const open = window.open.bind(window);
      window.popupAttempts = [];
      window.open = (...args) => {
        window.popupAttempts.push(args);
        return open(...args);
      };
    });
    await page.goto('/vm/2~pve/101');
    await page.getByRole('button', { name: type, exact: true }).click();
    await page.getByRole('button', { name: 'Minimize', exact: true }).click();
    await page.getByRole('button', { name: type, exact: true }).click();

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open in new tab', exact: true }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new RegExp(`/${type.toLowerCase()}/2~pve/101\\?name=`));
    expect(new URL(popup.url()).searchParams.get('name')).toBe(vm.name);
    expect(await popup.evaluate(() => window.opener)).toBe(null);
    expect(await page.evaluate(() => window.popupAttempts)).toEqual([['about:blank', '_blank']]);
    await expect(page.getByRole('button', { name: 'Open in new tab', exact: true })).toBeHidden();
    await expect(page.getByText('1 minimized', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `${type.toLowerCase()} ${type} — ${vm.name}`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open in new tab', exact: true })).toBeVisible();
    await popup.close();
  });

  test(`${type} blocked pop-out keeps the console and feedback through minimize/restore, then retries safely`, async ({ page, context }) => {
    await mockConsoleData(context);
    await page.addInitScript(() => {
      window.popupAttempts = [];
      window.popupEvents = [];
      window.blockPopup = true;
      window.open = (...args) => {
        window.popupAttempts.push(args);
        if (window.blockPopup) return null;
        return {
          set opener(value) { window.popupEvents.push(['opener', value]); },
          location: { set href(value) { window.popupEvents.push(['navigate', value]); } },
        };
      };
    });
    await page.goto('/vm/2~pve/101');
    await page.getByRole('button', { name: type, exact: true }).click();
    await page.getByRole('button', { name: 'Open in new tab', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Pop-up blocked. Allow pop-ups for this site, then try again. Your console is still open here.');
    expect(await page.evaluate(() => window.popupAttempts)).toEqual([['about:blank', '_blank']]);
    await expect(page.getByRole('button', { name: 'Open in new tab', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(page.getByText('1 minimized', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `${type.toLowerCase()} ${type} — ${vm.name}`, exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.evaluate(() => { window.blockPopup = false; });
    await page.getByRole('button', { name: 'Open in new tab', exact: true }).click();
    expect(await page.evaluate(() => window.popupEvents)).toEqual([
      ['opener', null],
      ['navigate', `/${type.toLowerCase()}/2~pve/101?name=${encodeURIComponent(vm.name)}`],
    ]);
    expect(await page.evaluate(() => window.popupAttempts)).toEqual([['about:blank', '_blank'], ['about:blank', '_blank']]);
    await expect(page.getByRole('button', { name: 'Open in new tab', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
