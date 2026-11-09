import { test, expect } from '@playwright/test';

// Ko-fi admin panel on /admin/paypal with a mocked API only: no backend, Ko-fi
// or PayPal is contacted. The fake below keeps just enough state for the lists
// to change after an action, and refuses reauth-gated calls until the identity
// check has been posted.
const admin = { id: 1, username: 'owner', isAdmin: true, twoFactorEnabled: true, require2fa: false, permissions: {} };
const users = [{ id: 7, username: 'anders' }, { id: 9, username: 'birgit' }, { id: 1, username: 'owner' }];
const TOKEN = 'kofi-token-9f3c2a7e51';
const KOFI = '/api/payments/admin/kofi';
const REAUTH_GATED = [/^\/config$/, /^\/enabled$/, /^\/review\/[^/]+\/(dismiss|settle)$/, /^\/receipts\/\d+\/(fee|reverse)$/];

const baseStatus = {
  enabled: false, configured: true, tokenStored: true, tokenUpdatedAt: '2026-11-01T09:00:00Z', pageUrl: 'https://ko-fi.com/aarislab',
  webhookUrl: 'https://lab.example.test/api/payments/kofi/webhook', webhookUrlError: null, updatedAt: '2026-11-01T09:00:00Z',
  lastEventAt: '2026-11-08T18:30:00Z', lastEventType: 'Donation', lastEventOutcome: 'needs_review', lastTestEventAt: '2026-11-01T09:05:00Z',
  lastErrorAt: '2026-11-02T07:00:00Z', lastErrorCode: 'INVALID_TOKEN', counts: { pending: 0, needsReview: 2, awaitingFee: 1, awaitingDkkAmount: 1 },
};
const reviewItem = (overrides) => ({
  id: 'live:kofi:11111111-aaaa-4bbb-8ccc-000000000001', eventType: 'Donation', status: 'needs_review', reason: 'MEMBER_UNMATCHED', linkable: true, settleable: false,
  matchedUserId: null, matchedUsername: null, receivedAt: '2026-11-08T18:30:00Z', eventAt: '2026-11-08T18:29:58Z',
  kofiTransactionId: '0a1fac0c-f960-4506-a60e-824979a74e71', attemptCount: 1, payloadRetained: true, amount: '50.00', currency: 'DKK',
  fromName: 'Anders A', email: 'anders@example.dk', message: 'Thanks for the lab', tierName: null,
  isSubscriptionPayment: false, isFirstSubscriptionPayment: false, resolution: null, resolvedAt: null, ...overrides,
});
const receipt = (overrides) => ({
  id: 41, transactionRef: '0A1FAC0CF9604506A60E824979A74E71', kind: 'donation', status: 'net_unresolved', userId: 7, username: 'anders',
  grossOre: 5000, feeOre: null, netOre: null, effectiveAt: '2026-11-05T12:00:00Z', observedAt: '2026-11-05T12:00:02Z', note: null,
  originalAmount: null, originalCurrency: null, ...overrides,
});

async function mockKofi(page, { status = baseStatus, review = [], receipts = [], members = [], reauthenticated = false } = {}) {
  const state = { status: { ...status }, review: [...review], receipts: [...receipts], members: [...members], reauthenticated, calls: [], responses: [] };
  const mutations = {
    'POST /config': ({ body }) => { state.status = { ...state.status, pageUrl: body.pageUrl, tokenStored: true, configured: true }; return { json: state.status }; },
    'POST /enabled': ({ body }) => { state.status = { ...state.status, enabled: body.enabled }; return { json: state.status }; },
    'POST /review/:id/link': ({ id, body }) => {
      const item = state.review.find((entry) => entry.id === id);
      state.review = state.review.filter((entry) => entry.id !== id);
      state.receipts.push(receipt({ id: 50, userId: body.userId, username: users.find((user) => user.id === body.userId)?.username ?? null, grossOre: Math.round(Number(item.amount) * 100) }));
      if (body.rememberEmail) state.members.push({ id: 3, userId: body.userId, username: 'anders', emailHint: 'an…@example.dk', source: 'admin_link', verifiedAt: '2026-11-09T10:00:00Z' });
      return { json: { status: 'linked', receiptId: 50 } };
    },
    'POST /review/:id/retry': () => ({ json: { status: 'pending' } }),
    'POST /review/:id/dismiss': ({ id }) => { state.review = state.review.filter((entry) => entry.id !== id); return { json: { status: 'dismissed' } }; },
    'POST /review/:id/settle': ({ id, body }) => {
      const item = state.review.find((entry) => entry.id === id);
      state.review = state.review.filter((entry) => entry.id !== id);
      const grossOre = Math.round(Number(body.grossDkk) * 100); const feeOre = Math.round(Number(body.fee) * 100);
      state.receipts.push(receipt({ id: 51, status: 'posted', userId: body.userId, username: 'anders', grossOre, feeOre, netOre: grossOre - feeOre,
        originalAmount: item.amount, originalCurrency: item.currency, note: body.note ?? null }));
      return { json: { status: 'settled', receiptId: 51, grossOre, feeOre, netOre: grossOre - feeOre } };
    },
    'POST /receipts/:id/fee': ({ id, body }) => {
      const feeOre = Math.round(Number(body.fee) * 100);
      state.receipts = state.receipts.map((entry) => String(entry.id) === id ? { ...entry, status: 'posted', feeOre, netOre: entry.grossOre - feeOre, note: body.note ?? null } : entry);
      const posted = state.receipts.find((entry) => String(entry.id) === id);
      return { json: { id: posted.id, status: 'posted', grossOre: posted.grossOre, feeOre, netOre: posted.netOre } };
    },
    'POST /receipts/:id/reverse': ({ id }) => {
      state.receipts = state.receipts.map((entry) => String(entry.id) === id ? { ...entry, status: entry.status === 'posted' ? 'reversed' : 'voided' } : entry);
      return { json: { id: Number(id), status: state.receipts.find((entry) => String(entry.id) === id).status } };
    },
    'POST /members': ({ body }) => {
      const added = { id: 4, userId: body.userId, username: users.find((user) => user.id === body.userId).username, emailHint: 'bi…@example.dk', source: 'admin_entry', verifiedAt: '2026-11-09T10:00:00Z' };
      state.members.push(added); return { status: 201, json: added };
    },
    'DELETE /members/:id': ({ id }) => { state.members = state.members.filter((entry) => String(entry.id) !== id); return { json: { removed: true } }; },
  };
  const reads = {
    '/config': () => state.status,
    '/review': (query) => ({ items: state.review.filter((entry) => (query.get('status') || 'needs_review') === 'all' || entry.status === 'needs_review'), nextOffset: null }),
    '/receipts': (query) => ({ items: state.receipts.filter((entry) => ['all', entry.status].includes(query.get('status') || 'net_unresolved')), nextOffset: null }),
    '/members': () => ({ items: state.members }),
  };
  const fulfill = (route, reply) => { state.responses.push(JSON.stringify(reply.json)); return route.fulfill(reply); };

  // The rest of the page (PayPal sections, shell) gets empty but well-formed answers.
  await page.route('**/api/**', (route) => route.fulfill({ json: route.request().method() === 'GET' ? [] : {} }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/admin/users', (route) => route.fulfill({ json: users }));
  await page.route('**/api/payments/admin/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/admin/config')) return route.fulfill({ json: [] });
    if (path.endsWith('/admin/allocation')) return route.fulfill({ json: { allocation: null } });
    if (path.endsWith('/admin/summary') || path.endsWith('/admin/health')) return route.fulfill({ json: {} });
    return route.fulfill({ json: { items: [], nextOffset: null } });
  });
  await page.route('**/api/auth/reauthenticate', (route) => { state.reauthenticated = true; return route.fulfill({ json: { ok: true } }); });
  await page.route(`**${KOFI}/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rawPath = url.pathname.slice(KOFI.length);
    const method = request.method();
    if (method === 'GET') {
      const read = reads[rawPath];
      state.calls.push({ method, path: rawPath, query: url.search });
      return read ? fulfill(route, { json: read(url.searchParams) }) : route.fulfill({ status: 404, json: { error: 'UNEXPECTED' } });
    }
    const body = request.postDataJSON();
    state.calls.push({ method, path: rawPath, body });
    if (REAUTH_GATED.some((pattern) => pattern.test(rawPath)) && !state.reauthenticated) {
      return fulfill(route, { status: 403, json: { error: 'Recent identity confirmation required', code: 'REAUTHENTICATION_REQUIRED' } });
    }
    // /review/<url-encoded inbox id>/<action>, /receipts/<n>/<action>, /members/<n>
    const [, collection, encodedId, action] = rawPath.split('/');
    const key = encodedId === undefined ? `${method} /${collection}` : `${method} /${collection}/:id${action ? `/${action}` : ''}`;
    const handler = mutations[key];
    return handler ? fulfill(route, handler({ id: encodedId === undefined ? undefined : decodeURIComponent(encodedId), body }))
      : route.fulfill({ status: 404, json: { error: 'UNEXPECTED' } });
  });
  state.writes = () => state.calls.filter((call) => call.method !== 'GET');
  return state;
}

const kofi = (page) => page.getByRole('region', { name: 'Ko-fi' });
const confirmIdentity = async (page) => {
  await expect(page.getByRole('dialog', { name: 'Confirm your identity' })).toBeVisible();
  await page.getByPlaceholder('Current password').fill('fixture-password');
  await page.getByRole('button', { name: 'Confirm & continue' }).click();
};

test('the verification token is write-only and saving goes through the identity check', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state = await mockKofi(page);
  await page.goto('/admin/paypal');
  await expect(page.getByRole('heading', { name: 'Support payments', level: 1 })).toBeVisible();
  const panel = kofi(page);
  await expect(panel.getByText('Configured', { exact: true })).toBeVisible();
  // The panel sits below the PayPal sections; the page header links straight to it.
  await expect(panel.getByRole('heading', { name: 'Ko-fi setup · live' })).not.toBeInViewport();
  await page.getByRole('link', { name: /Ko-fi setup, review and receipts/ }).click();
  await expect(panel.getByRole('heading', { name: 'Ko-fi setup · live' })).toBeInViewport();
  await expect(panel.getByText('Ko-fi disabled')).toBeVisible();
  await expect(panel.getByText('Awaiting DKK amount').locator('..')).toContainText('1');
  await expect(panel.getByText('Last error').locator('..')).toContainText('INVALID_TOKEN');

  // The webhook URL is shown for copying; the stored token is never shown or prefilled.
  await expect(panel.getByLabel('Webhook URL')).toHaveValue(baseStatus.webhookUrl);
  await panel.getByRole('button', { name: 'Copy' }).click();
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(baseStatus.webhookUrl);
  const token = panel.getByLabel('Verification token');
  await expect(token).toHaveAttribute('type', 'password');
  await expect(token).toHaveAttribute('autocomplete', 'off');
  await expect(token).toHaveValue('');
  await expect(token).toHaveAttribute('placeholder', /A token is stored/);
  await expect(panel.getByLabel('Ko-fi page URL')).toHaveValue('https://ko-fi.com/aarislab');

  // Saving with a blank token keeps the stored one: the field is not sent at all.
  await panel.getByLabel('Ko-fi page URL').fill('https://ko-fi.com/aarislab2');
  await panel.getByRole('button', { name: 'Save Ko-fi settings' }).click();
  await confirmIdentity(page);
  await expect(page.getByText('Operation completed.')).toBeVisible();
  expect(state.writes().map((call) => call.body)).toEqual([{ pageUrl: 'https://ko-fi.com/aarislab2' }, { pageUrl: 'https://ko-fi.com/aarislab2' }]);

  // A new token is sent once, then cleared from the form and never echoed back.
  await token.fill(TOKEN);
  await panel.getByRole('button', { name: 'Save Ko-fi settings' }).click();
  await expect.poll(() => state.writes().length).toBe(3);
  expect(state.writes()[2]).toEqual({ method: 'POST', path: '/config', body: { pageUrl: 'https://ko-fi.com/aarislab2', verificationToken: TOKEN } });
  await expect(token).toHaveValue('');
  await expect(page.getByText(TOKEN)).toHaveCount(0);
  expect(await page.content()).not.toContain(TOKEN);
  expect(state.responses.join('\n')).not.toContain(TOKEN);

  await panel.getByRole('button', { name: 'Enable Ko-fi' }).click();
  await expect(panel.getByText('Ko-fi enabled')).toBeVisible();
  expect(state.writes()[3]).toEqual({ method: 'POST', path: '/enabled', body: { enabled: true } });
});

test('a review item can be linked to a member or dismissed with a note', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__kofiXss = 1">';
  const second = 'live:kofi:22222222-aaaa-4bbb-8ccc-000000000002';
  const state = await mockKofi(page, { review: [
    reviewItem(),
    reviewItem({ id: second, eventType: 'Shop Order', reason: 'UNSUPPORTED_TYPE', linkable: false, amount: '120.00', fromName: hostile, email: 'shopper@example.com', message: hostile }),
  ] });
  await page.goto('/admin/paypal');
  const panel = kofi(page);
  const donation = panel.getByRole('row', { name: /MEMBER_UNMATCHED/ });
  const shopOrder = panel.getByRole('row', { name: /UNSUPPORTED_TYPE/ });
  await expect(donation).toContainText('50.00 DKK');
  await expect(donation).toContainText('anders@example.dk');
  // Payer text is untrusted: it is shown as text and never becomes markup.
  await expect(shopOrder).toContainText(hostile);
  await expect(panel.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__kofiXss)).toBeUndefined();
  await expect(shopOrder.getByRole('button', { name: 'Link' })).toHaveCount(0);
  await expect(shopOrder.getByRole('button', { name: 'Record in DKK' })).toHaveCount(0);

  // Link: a member must be chosen; the email is remembered by default.
  await donation.getByRole('button', { name: 'Link' }).click();
  const linkForm = panel.getByRole('form', { name: 'Link payment' });
  await expect(linkForm.getByRole('button', { name: 'Link payment' })).toBeDisabled();
  await linkForm.getByLabel('Member', { exact: true }).selectOption({ label: 'anders' });
  await expect(linkForm.getByLabel(/Remember this email/)).toBeChecked();
  await linkForm.getByRole('button', { name: 'Link payment' }).click();
  await expect(page.getByText('Operation completed.')).toBeVisible();
  expect(state.writes()).toEqual([{ method: 'POST', path: `/review/${encodeURIComponent(reviewItem().id)}/link`, body: { userId: 7, rememberEmail: true } }]);
  // The lists reload: the event left the queue, a receipt awaits its fee, the email is linked.
  await expect(panel.getByRole('row', { name: /MEMBER_UNMATCHED/ })).toHaveCount(0);
  await expect(panel.getByRole('row', { name: /awaiting fee/ })).toContainText('anders');
  await expect(panel.getByRole('row', { name: /Linked from review/ })).toContainText('an…@example.dk');

  // Dismiss: a note is required and the request goes through the identity check.
  await shopOrder.getByRole('button', { name: 'Dismiss' }).click();
  const dismissForm = panel.getByRole('form', { name: 'Dismiss event' });
  await expect(dismissForm.getByRole('button', { name: 'Dismiss event' })).toBeDisabled();
  await dismissForm.getByLabel(/Why is this not lab income/).fill('Shop order, not a contribution');
  await dismissForm.getByRole('button', { name: 'Dismiss event' }).click();
  await confirmIdentity(page);
  await expect(panel.getByText('No Ko-fi events need review.')).toBeVisible();
  const dismissal = { method: 'POST', path: `/review/${encodeURIComponent(second)}/dismiss`, body: { note: 'Shop order, not a contribution' } };
  expect(state.writes().slice(1)).toEqual([dismissal, dismissal]);
});

test('a fee can be entered for a receipt awaiting its fee', async ({ page }) => {
  const state = await mockKofi(page, { receipts: [receipt()], reauthenticated: true });
  await page.goto('/admin/paypal');
  const panel = kofi(page);
  const row = panel.getByRole('row', { name: /awaiting fee/ });
  await expect(row).toContainText('50,00');
  await expect(row.getByRole('button', { name: 'Reverse' })).toHaveCount(0);
  // The default filter asks only for receipts awaiting a fee.
  const receiptQueries = state.calls.filter((call) => call.path === '/receipts').map((call) => call.query);
  expect(receiptQueries.length).toBeGreaterThan(0);
  expect(new Set(receiptQueries)).toEqual(new Set(['?status=net_unresolved']));

  await row.getByRole('button', { name: 'Enter fee' }).click();
  const form = panel.getByRole('form', { name: 'Enter fee' });
  // Gross, fee and the resulting net are all on screen before anything is posted.
  await expect(form.getByText('DKK amount before fees').locator('..')).toContainText('50,00');
  await expect(form.getByText(/^Counts as:/)).toHaveText('Counts as: —');
  await expect(form.getByRole('button', { name: 'Post fee' })).toBeDisabled();
  await form.getByLabel('Fee in DKK').fill('60');
  await expect(form.getByText('Enter a fee from 0,00 up to the amount before fees.')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Post fee' })).toBeDisabled();
  await form.getByLabel('Fee in DKK').fill('1,95');
  await expect(form.getByText(/^Counts as:/)).toContainText('48,05');
  await form.getByRole('button', { name: 'Post fee' }).click();
  await expect(page.getByText('Operation completed.')).toBeVisible();
  expect(state.writes()).toEqual([{ method: 'POST', path: '/receipts/41/fee', body: { fee: '1.95' } }]);
  await expect(panel.getByText('No Ko-fi receipts are awaiting a fee.')).toBeVisible();

  // The posted receipt shows fee and net, and can only be reversed with a reason.
  await panel.getByLabel('Receipts shown').selectOption('posted');
  const posted = panel.getByRole('row', { name: /posted/ });
  await expect(posted).toContainText('1,95');
  await expect(posted).toContainText('48,05');
  await expect(posted.getByRole('button', { name: 'Enter fee' })).toHaveCount(0);
  await posted.getByRole('button', { name: 'Reverse' }).click();
  const reverseForm = panel.getByRole('form', { name: 'Reverse receipt' });
  await expect(reverseForm.getByRole('button', { name: 'Reverse receipt' })).toBeDisabled();
  await reverseForm.getByLabel(/Reason/).fill('Refunded at Ko-fi');
  await reverseForm.getByRole('button', { name: 'Reverse receipt' }).click();
  await expect.poll(() => state.writes().length).toBe(2);
  expect(state.writes()[1]).toEqual({ method: 'POST', path: '/receipts/41/reverse', body: { reason: 'Refunded at Ko-fi' } });
});

test('a foreign-currency payment is recorded with the DKK amount received', async ({ page }) => {
  const id = 'live:kofi:33333333-aaaa-4bbb-8ccc-000000000003';
  const state = await mockKofi(page, { review: [
    reviewItem({ id, reason: 'CURRENCY_NOT_DKK', linkable: false, settleable: true, amount: '5.00', currency: 'EUR', matchedUserId: 7, matchedUsername: 'anders' }),
  ] });
  await page.goto('/admin/paypal');
  const panel = kofi(page);
  const row = panel.getByRole('row', { name: /CURRENCY_NOT_DKK/ });
  await expect(row).toContainText('5.00 EUR');
  await expect(row).toContainText('linked to anders');
  await expect(row.getByRole('button', { name: 'Link' })).toHaveCount(0);

  await row.getByRole('button', { name: 'Record in DKK' }).click();
  const form = panel.getByRole('form', { name: 'Record payment in DKK' });
  // The member the email is already linked to is preselected, so there is nothing to remember.
  await expect(form.getByLabel('Member', { exact: true })).toHaveValue('7');
  await expect(form.getByLabel(/Remember this email/)).toHaveCount(0);
  await expect(form.getByRole('option', { name: /No member/ })).toBeAttached();
  await expect(form.getByText(/^Counts as:/)).toHaveText('Counts as: —');
  await expect(form.getByRole('button', { name: 'Record payment' })).toBeDisabled();

  // The first amount is the gross before fees; the net shown is what will count.
  await form.getByLabel('DKK amount before fees').fill('37,25');
  await form.getByLabel('Fee in DKK').fill('40');
  await expect(form.getByText('Enter a fee from 0,00 up to the amount before fees.')).toBeVisible();
  await expect(form.getByText(/^Counts as:/)).toHaveText('Counts as: —');
  await expect(form.getByRole('button', { name: 'Record payment' })).toBeDisabled();
  await form.getByLabel('Fee in DKK').fill('1,95');
  await expect(form.getByText(/^Counts as:/)).toContainText('35,30');
  await form.getByRole('button', { name: 'Record payment' }).click();
  await confirmIdentity(page);
  await expect(panel.getByText('No Ko-fi events need review.')).toBeVisible();

  // A typed decimal comma is sent as a dot, as decimal strings, before and after the identity check.
  const settlement = { method: 'POST', path: `/review/${encodeURIComponent(id)}/settle`, body: { userId: 7, grossDkk: '37.25', fee: '1.95', rememberEmail: false } };
  expect(state.writes()).toEqual([settlement, settlement]);

  // The posted DKK receipt keeps the original amount next to the DKK gross.
  await panel.getByLabel('Receipts shown').selectOption('posted');
  const posted = panel.getByRole('row', { name: /posted/ });
  await expect(posted).toContainText('37,25');
  await expect(posted).toContainText('5.00 EUR');
  await expect(posted).toContainText('35,30');
});

test('an unlinked foreign-currency payer can be remembered or left without a member', async ({ page }) => {
  const id = 'live:kofi:44444444-aaaa-4bbb-8ccc-000000000004';
  const state = await mockKofi(page, { reauthenticated: true, review: [
    reviewItem({ id, reason: 'CURRENCY_NOT_DKK', linkable: false, settleable: true, amount: '10.00', currency: 'EUR' }),
  ] });
  await page.goto('/admin/paypal');
  const panel = kofi(page);
  await panel.getByRole('row', { name: /CURRENCY_NOT_DKK/ }).getByRole('button', { name: 'Record in DKK' }).click();
  const form = panel.getByRole('form', { name: 'Record payment in DKK' });
  await expect(form.getByLabel('Member', { exact: true })).toHaveValue('');
  await form.getByLabel('Member', { exact: true }).selectOption({ label: 'birgit' });
  await expect(form.getByLabel(/Remember this email/)).toBeChecked();
  // Without a member there is nobody to remember the email for.
  await form.getByLabel('Member', { exact: true }).selectOption('none');
  await expect(form.getByLabel(/Remember this email/)).toHaveCount(0);
  await form.getByLabel('Member', { exact: true }).selectOption({ label: 'birgit' });
  await form.getByLabel('DKK amount before fees').fill('74.6');
  await form.getByLabel('Fee in DKK').fill('0');
  await form.getByLabel(/Note/).fill('  Stripe payout 12 Nov  ');
  await form.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Operation completed.')).toBeVisible();
  expect(state.writes()).toEqual([{ method: 'POST', path: `/review/${encodeURIComponent(id)}/settle`,
    body: { userId: 9, grossDkk: '74.6', fee: '0', rememberEmail: true, note: 'Stripe payout 12 Nov' } }]);
});

test('an email can be linked in advance and unlinked again', async ({ page }) => {
  const state = await mockKofi(page);
  await page.goto('/admin/paypal');
  const panel = kofi(page);
  await expect(panel.getByText('No emails linked yet.')).toBeVisible();
  const form = panel.getByRole('form', { name: 'Link an email' });
  await form.getByLabel('Member', { exact: true }).selectOption({ label: 'birgit' });
  await form.getByLabel('Email the member uses on Ko-fi').fill('birgit@example.dk');
  await form.getByRole('button', { name: 'Link email' }).click();
  const row = panel.getByRole('row', { name: /Entered in advance/ });
  await expect(row).toContainText('bi…@example.dk');
  // Only the masked hint comes back; the typed address is cleared from the form.
  await expect(form.getByLabel('Email the member uses on Ko-fi')).toHaveValue('');
  await expect(panel.getByText('birgit@example.dk')).toHaveCount(0);
  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlink' }).click();
  await expect(panel.getByText('No emails linked yet.')).toBeVisible();
  expect(state.writes()).toEqual([
    { method: 'POST', path: '/members', body: { userId: 9, email: 'birgit@example.dk' } },
    { method: 'DELETE', path: '/members/4', body: null },
  ]);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('the Ko-fi panel does not scroll the page sideways and its forms stay within the screen', async ({ page }) => {
    await mockKofi(page, {
      review: [reviewItem({ id: 'live:kofi:55555555-aaaa-4bbb-8ccc-000000000005', reason: 'CURRENCY_NOT_DKK', linkable: false, settleable: true, amount: '5.00', currency: 'EUR',
        fromName: 'A payer with a very long display name that should be cut short in the table', message: 'x'.repeat(400) })],
      receipts: [receipt()],
    });
    await page.goto('/admin/paypal');
    const panel = kofi(page);
    await panel.getByRole('button', { name: 'Record in DKK' }).scrollIntoViewIfNeeded();
    await panel.getByRole('button', { name: 'Record in DKK' }).click();
    const form = panel.getByRole('form', { name: 'Record payment in DKK' });
    await expect(form.getByLabel('DKK amount before fees')).toBeVisible();
    // The shell clips the document, so the scrolling <main> is checked too.
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.querySelector('main').scrollWidth) <= window.innerWidth)).toBe(true);
    const box = await form.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
