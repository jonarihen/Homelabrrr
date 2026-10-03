import { test, expect } from '@playwright/test';

const expired = { code: 'SFTP_SESSION_EXPIRED', error: 'SFTP session expired or invalid' };
const entries = [
  { name: 'folder', type: 'directory', size: 0 },
  { name: 'x.txt', type: 'file', size: 8 },
];

async function openFiles(page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: {
    id: 11, username: 'operator', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions: {},
  } }));
  await page.route('**/api/vms/1~pve/101/status', route => route.fulfill({ json: { name: 'test-vm' } }));
  await page.route('**/api/ssh/keys', route => route.fulfill({ json: [{ id: 1, name: 'test-key' }] }));
  await page.route('**/api/ssh/config/1~pve/101', route => route.fulfill({ json: {
    host: '192.0.2.10', port: 22, username: 'root', hostFingerprint: 'SHA256:test',
  } }));
  await page.route('**/api/ssh/connect', route => route.fulfill({ json: { token: 'ssh-token' } }));
  await page.routeWebSocket('**/api/ssh', socket => {
    socket.send(JSON.stringify({ type: 'status', status: 'connected' }));
  });
  let minted = 0;
  const connectBodies = [];
  const listings = [];
  await page.route('**/api/sftp/connect', route => {
    connectBodies.push(route.request().postDataJSON());
    minted += 1;
    return route.fulfill({ json: { token: `sftp-token-${minted}` } });
  });
  await page.route('**/api/sftp/ls', route => {
    listings.push(route.request().postDataJSON());
    return route.fulfill({ json: { path: '/home/operator', entries } });
  });
  await page.goto('/ssh/1~pve/101');
  await page.locator('input[placeholder="Leave empty if none"]').fill('test-passphrase');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByText('x.txt', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.sftpPageMarker = 'still-mounted'; });
  return { connectBodies, listings };
}

for (const operation of ['ls', 'download', 'upload', 'mkdir', 'delete', 'rename']) {
  test(`${operation} expiry keeps the console page and offers an in-place reconnect`, async ({ page }) => {
    const { connectBodies, listings } = await openFiles(page);
    let failedRequests = 0;
    await page.route(`**/api/sftp/${operation}${operation === 'download' ? '?*' : ''}`, route => {
      failedRequests += 1;
      return route.fulfill({ status: 410, json: expired });
    });

    if (operation === 'ls') {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    } else if (operation === 'download') {
      await page.getByRole('button', { name: 'Download', exact: true }).click();
    } else if (operation === 'upload') {
      await page.locator('input[type="file"]').setInputFiles([
        { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
        { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') },
      ]);
    } else if (operation === 'mkdir') {
      await page.getByRole('button', { name: 'New folder', exact: true }).click();
      await page.getByPlaceholder('New folder name').fill('new-folder');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
    } else if (operation === 'delete') {
      await page.getByRole('row').filter({ hasText: 'x.txt' }).getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('button', { name: 'Yes', exact: true }).click();
    } else {
      page.once('dialog', dialog => dialog.accept('renamed.txt'));
      await page.getByRole('row').filter({ hasText: 'x.txt' }).getByRole('button', { name: 'Rename', exact: true }).click();
    }

    await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toBeVisible();
    await expect(page).toHaveURL(/\/ssh\/1~pve\/101$/);
    expect(failedRequests).toBe(1);
    await page.unroute(`**/api/sftp/${operation}${operation === 'download' ? '?*' : ''}`);
    if (operation === 'ls') {
      await page.route('**/api/sftp/ls', route => {
        listings.push(route.request().postDataJSON());
        return route.fulfill({ json: { path: '/home/operator', entries } });
      });
    }
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toHaveCount(0);
    await expect(page.getByText('x.txt', { exact: true })).toBeVisible();
    expect(connectBodies).toHaveLength(2);
    expect(connectBodies[1]).toEqual(connectBodies[0]);
    expect(listings.at(-1)).toEqual({ token: 'sftp-token-2', path: '/home/operator' });
    expect(await page.evaluate(() => window.sftpPageMarker)).toBe('still-mounted');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  });
}

test('a revoked-access download stays on the portal without offering token reconnect', async ({ page }) => {
  const { connectBodies } = await openFiles(page);
  await page.route('**/api/sftp/download?*', route => route.fulfill({ status: 403, json: { error: 'Access denied' } }));
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Access denied');
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/ssh\/1~pve\/101$/);
  expect(connectBodies).toHaveLength(1);
  expect(await page.evaluate(() => window.sftpPageMarker)).toBe('still-mounted');
});

test('a real portal-auth 401 during token reconnect still leaves for login', async ({ page }) => {
  await openFiles(page);
  await page.route('**/api/sftp/ls', route => route.fulfill({ status: 410, json: expired }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toBeVisible();
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/sftp/connect', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('a real portal-auth 401 from a Blob download still leaves for login', async ({ page }) => {
  await openFiles(page);
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/sftp/download?*', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});
