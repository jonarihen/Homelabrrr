import crypto from 'node:crypto';

// Ko-fi webhook fixtures for tests. The shape follows Ko-fi's documented
// payload: a form field `data` holding one JSON object. Nothing here touches
// the network or the database.

export const KOFI_TEST_TOKEN = '8c2a3835-4544-4f27-a53a-adfd1fcc5664';
/** The transaction id Ko-fi's own "send test" buttons use. */
export const KOFI_SAMPLE_TRANSACTION_ID = '00000000-1111-2222-3333-444444444444';

export type KofiEvent = Record<string, unknown>;

/** Ko-fi sends UTC without milliseconds, e.g. 2023-07-29T16:27:32Z. */
export function kofiTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A one-off DKK donation. Every call gets a fresh message and transaction id. */
export function kofiEvent(overrides: KofiEvent = {}): KofiEvent {
  const transactionId = crypto.randomUUID();
  return {
    verification_token: KOFI_TEST_TOKEN,
    message_id: crypto.randomUUID(),
    timestamp: kofiTimestamp(),
    type: 'Donation',
    is_public: true,
    from_name: 'Jo Example',
    message: 'Good luck with the integration!',
    amount: '50.00',
    url: `https://ko-fi.com/Home/CoffeeShop?txid=${transactionId}`,
    email: 'jo@example.com',
    currency: 'DKK',
    is_subscription_payment: false,
    is_first_subscription_payment: false,
    kofi_transaction_id: transactionId,
    shop_items: null,
    tier_name: null,
    shipping: null,
    ...overrides,
  };
}

/** A membership payment: the first one or a later monthly one. */
export function kofiSubscriptionEvent(first: boolean, overrides: KofiEvent = {}): KofiEvent {
  return kofiEvent({ type: 'Subscription', is_subscription_payment: true, is_first_subscription_payment: first, tier_name: 'Gold', ...overrides });
}

/** A shop order with the postal address Ko-fi includes for physical goods. */
export function kofiShopOrderEvent(overrides: KofiEvent = {}): KofiEvent {
  return kofiEvent({
    type: 'Shop Order',
    shop_items: [{ direct_link_code: '1a2b3c4d5e', variation_name: 'Blue', quantity: 1 }],
    shipping: { full_name: 'Jo Example', street_address: '1 Secret Street', city: 'Aarhus', state_or_province: 'Midtjylland',
      postal_code: '8000', country: 'Denmark', country_code: 'DK', telephone: '+4500000000' },
    ...overrides,
  });
}

/** The request body Ko-fi posts: `data=<url-encoded JSON>`. */
export function kofiFormBody(event: unknown): string {
  return new URLSearchParams({ data: typeof event === 'string' ? event : JSON.stringify(event) }).toString();
}

/** The stored reference for a Ko-fi transaction id: uppercase, alphanumerics only. */
export function kofiKey(transactionId: unknown): string {
  return String(transactionId).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
