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

test('superseded listings are cancelled and cannot replace the confirmed directory', async ({ page }) => {
  const { listings } = await openFiles(page);
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  await page.route('**/api/sftp/ls', async route => {
    const body = route.request().postDataJSON();
    listings.push(body);
    if (body.path === '/home/operator/folder') {
      started.resolve();
      await pending.promise;
      try {
        await route.fulfill({ json: { path: body.path, entries: [{ name: 'stale.txt', type: 'file' }] } });
      } catch {}
      released.resolve();
      return;
    }
    await route.fulfill({ json: { path: body.path, entries } });
  });
  await page.getByRole('button', { name: 'folder', exact: true }).click();
  await started.promise;
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeDisabled();
  const cancelled = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/sftp/ls'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await cancelled;
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
  pending.resolve();
  await released.promise;
  await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('x.txt', { exact: true })).toBeVisible();
  expect(listings.at(-1)).toEqual({ token: 'sftp-token-1', path: '/home/operator' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const oldMutationStatus of [200, 410]) {
  test(`expiry cancels navigation and ignores a late old-token mutation (${oldMutationStatus}) after reconnect`, async ({ page }) => {
    const { listings } = await openFiles(page);
    const deletion = Promise.withResolvers();
    const deletionStarted = Promise.withResolvers();
    const deletionReleased = Promise.withResolvers();
    await page.route('**/api/sftp/delete', async route => {
      deletionStarted.resolve();
      await deletion.promise;
      await route.fulfill({ status: oldMutationStatus, json: oldMutationStatus === 410 ? expired : { ok: true } });
      deletionReleased.resolve();
    });
    const download = Promise.withResolvers();
    const downloadStarted = Promise.withResolvers();
    await page.route('**/api/sftp/download?*', async route => {
      downloadStarted.resolve();
      await download.promise;
      await route.fulfill({ status: 410, json: expired });
    });
    const pendingListing = Promise.withResolvers();
    const listingStarted = Promise.withResolvers();
    const listingReleased = Promise.withResolvers();
    await page.route('**/api/sftp/ls', async route => {
      const body = route.request().postDataJSON();
      listings.push(body);
      if (body.token === 'sftp-token-1') {
        listingStarted.resolve();
        await pendingListing.promise;
        try {
          await route.fulfill({ json: { path: '/stale', entries: [{ name: 'stale.txt', type: 'file' }] } });
        } catch {}
        listingReleased.resolve();
        return;
      }
      await route.fulfill({ json: { path: body.path, entries } });
    });
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await downloadStarted.promise;
    await page.getByRole('row').filter({ hasText: 'x.txt' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await deletionStarted.promise;
    await page.getByRole('button', { name: 'folder', exact: true }).click();
    await listingStarted.promise;
    const cancelled = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/sftp/ls'));
    download.resolve();
    await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toBeVisible();
    await cancelled;
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
    const reconnectedListings = listings.length;
    const mutationFinished = page.waitForResponse(response => response.url().endsWith('/api/sftp/delete'));
    deletion.resolve();
    pendingListing.resolve();
    await Promise.all([deletionReleased.promise, listingReleased.promise, mutationFinished]);
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await expect(page.getByPlaceholder('New folder name')).toBeVisible();
    expect(listings).toHaveLength(reconnectedListings);
    expect(listings.at(-1)).toEqual({ token: 'sftp-token-2', path: '/home/operator' });
    await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toHaveCount(0);
    await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/ssh\/1~pve\/101$/);
  });
}

test('an old-token upload batch cannot send more files or refresh after reconnect', async ({ page }) => {
  const { listings } = await openFiles(page);
  const upload = Promise.withResolvers();
  const uploadStarted = Promise.withResolvers();
  const uploads = [];
  await page.route('**/api/sftp/upload', async route => {
    uploads.push(route.request().postData());
    uploadStarted.resolve();
    await upload.promise;
    await route.fulfill({ json: { ok: true } });
  });
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
    { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') },
  ]);
  await uploadStarted.promise;
  await page.route('**/api/sftp/download?*', route => route.fulfill({ status: 410, json: expired }));
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByText('The file browser session expired. Reconnect to keep browsing.')).toHaveCount(0);
  expect(listings.at(-1)).toEqual({ token: 'sftp-token-2', path: '/home/operator' });
  const count = listings.length;
  upload.resolve();
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
  expect(uploads).toHaveLength(1);
  expect(listings).toHaveLength(count);
});

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
