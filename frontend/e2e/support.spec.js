import { test, expect } from '@playwright/test';

// Support page with a mocked API only: no PayPal or backend is contacted.
const member = { id: 7, username: 'friend', isAdmin: false, twoFactorEnabled: true, require2fa: false, permissions: {} };
const status = { environment: 'live', configured: true, checkoutEnabled: true, monthlyAvailable: true, monthlyAmountOre: null, monthlyOptions: [2500, 7500] };
const history = { items: [], postings: [], subscriptions: [], manualReports: [] };

async function mockSupport(page, overrides = {}) {
  const posts = [];
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: member }));
  await page.route('**/api/payments/status', (route) => route.fulfill({ json: { ...status, ...overrides.status } }));
  await page.route('**/api/payments/mine', (route) => route.fulfill({ json: { ...history, ...overrides.history } }));
  await page.route('**/api/payments/**', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const path = new URL(route.request().url()).pathname;
    posts.push({ path, body: route.request().postDataJSON() });
    const reply = overrides.posts?.[path];
    return reply ? route.fulfill(reply) : route.fulfill({ status: 404, json: { error: 'UNEXPECTED' } });
  });
  return posts;
}

test('anonymous access redirects before any private payment request', async ({ page }) => {
  let privateRequests = 0;
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/payments/**', (route) => { privateRequests += 1; return route.fulfill({ status: 401, json: { error: 'Unauthorized' } }); });
  await page.goto('/support');
  await expect(page).toHaveURL(/\/login$/);
  expect(privateRequests).toBe(0);
});

test('a PayPal return redirect alone never shows success; only a verified capture does', async ({ page }) => {
  const posts = await mockSupport(page, { posts: {
    '/api/payments/one-off/intent-1/capture': { json: { status: 'pending_verification' } },
  } });
  await page.addInitScript(() => sessionStorage.setItem('paypalPendingIntent', 'intent-1'));
  await page.goto('/support?paypal=one-off');
  await expect(page.getByRole('status')).toContainText('pending verification');
  await expect(page.getByText(/verified\. Thank you/)).toHaveCount(0);
  expect(posts.map((item) => item.path)).toEqual(['/api/payments/one-off/intent-1/capture']);
});

test('monthly checkout sends only the chosen offered amount, never a plan ID', async ({ page }) => {
  const posts = await mockSupport(page, { posts: {
    '/api/payments/monthly': { status: 400, json: { error: 'STOP_BEFORE_REDIRECT' } },
  } });
  await page.goto('/support');
  await expect(page.getByText('entirely voluntary')).toBeVisible();
  await page.getByRole('radio', { name: /75,00/ }).click();
  await page.getByRole('button', { name: 'Review monthly subscription' }).click();
  await expect(page.getByRole('alert')).toContainText('STOP_BEFORE_REDIRECT');
  expect(posts).toEqual([{ path: '/api/payments/monthly', body: { environment: 'live', amount: '75.00' } }]);
});

test('a bank-transfer report is shown as awaiting confirmation, not as a contribution', async ({ page }) => {
  await mockSupport(page, { history: { manualReports: [{ id: 1, amountOre: 25000, reference: 'BANK-REF-1', receivedAt: '2026-10-08T00:00:00Z', status: 'reported' }] } });
  await page.goto('/support');
  await expect(page.getByText('awaiting confirmation')).toBeVisible();
  await expect(page.getByText('No verified contributions recorded.')).toBeVisible();
});
