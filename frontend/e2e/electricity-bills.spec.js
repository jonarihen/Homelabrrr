import { test, expect } from '@playwright/test';

// Admin bill list/void/revise with a mocked API only.
const admin = { id: 1, username: 'owner', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };
const bill = { id: 5, contract_id: 3, period_start: '2026-08-31T22:00:00Z', period_end: '2026-09-30T22:00:00Z', amount_ore: 150000, billed_kwh: null,
  status: 'due', paid_ore: null, paid_at: null, reference: 'REF-1', note: null, kind: 'settlement', revision: 1, previous_id: null, void_reason: null };

test('a bill is voided with an audited reason after identity confirmation; voided revisions are hidden by default', async ({ page }) => {
  const posts = [];
  let reauthenticated = false;
  let bills = [bill];
  await page.route('**/api/**', (route) => route.fulfill({ json: route.request().method() === 'GET' ? [] : {} }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/admin/energy-data/status', (route) => route.fulfill({ json: { configured: false, enabled: false } }));
  await page.route('**/api/admin/electricity-pricing/bills', (route) => route.fulfill({ json: bills }));
  await page.route('**/api/auth/reauthenticate', (route) => { reauthenticated = true; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/admin/electricity-pricing/bills/5/void', (route) => {
    posts.push(route.request().postDataJSON());
    if (!reauthenticated) return route.fulfill({ status: 403, json: { error: 'confirm', code: 'REAUTHENTICATION_REQUIRED' } });
    bills = [{ ...bill, status: 'void', void_reason: 'duplicate upload' }];
    return route.fulfill({ json: bills[0] });
  });
  await page.goto('/admin/energy-data');
  const panel = page.getByRole('region', { name: 'Recorded household bills' });
  await expect(panel.getByRole('cell', { name: 'Due' })).toBeVisible();
  await panel.getByRole('button', { name: 'Void' }).click();
  await panel.getByLabel('Reason (audited)').fill('duplicate upload');
  await panel.getByRole('button', { name: 'Void bill' }).click();
  await page.getByPlaceholder('Current password').fill('fixture-password');
  await page.getByRole('button', { name: 'Confirm & continue' }).click();
  await expect(panel.getByText('Bill voided.')).toBeVisible();
  expect(posts).toEqual([{ reason: 'duplicate upload' }, { reason: 'duplicate upload' }]);
  await expect(panel.getByText('No bills recorded.')).toBeVisible();
  await panel.getByLabel('Show voided revisions').check();
  await expect(panel.getByText('duplicate upload')).toBeVisible();
});
