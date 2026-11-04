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

async function windowSnapshot(page) {
  return page.evaluate(() => (
    [...document.querySelectorAll('[aria-roledescription="movable window"]')].map((handle) => ({
      title: handle.getAttribute('aria-label'),
      z: handle.parentElement.style.zIndex,
    }))
  ));
}

test('console windows enforce the 320x240 minimum and raise on title-bar focus', async ({ page, context }) => {
  await mockConsoleData(context);
  await page.goto('/vm/2~pve/101');
  await page.getByRole('button', { name: 'VNC', exact: true }).click();
  await page.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.getByRole('button', { name: 'VNC', exact: true }).click();
  await page.getByRole('button', { name: 'vnc VNC — Lab console & tools / #1', exact: true }).click();

  const mins = await page.evaluate(() => {
    const handle = document.querySelector('[aria-roledescription="movable window"]');
    const style = getComputedStyle(handle.parentElement);
    return { minWidth: style.minWidth, minHeight: style.minHeight };
  });
  expect(mins).toEqual({ minWidth: '320px', minHeight: '240px' });

  const handles = page.getByRole('group', { name: /Move VNC — Lab console & tools/ });
  await expect(handles).toHaveCount(2);
  let snapshot = await windowSnapshot(page);
  const older = snapshot.find((s) => !s.title.includes('#2 window'));
  const newer = snapshot.find((s) => s.title.includes('#2 window'));
  expect(Number(newer.z)).toBeLessThan(Number(older.z));

  await handles.nth(0).focus();
  snapshot = await windowSnapshot(page);
  const raisedNewer = snapshot.find((s) => s.title.includes('#2 window'));
  const demotedOlder = snapshot.find((s) => !s.title.includes('#2 window'));
  expect(Number(raisedNewer.z)).toBeGreaterThan(Number(demotedOlder.z));
});
