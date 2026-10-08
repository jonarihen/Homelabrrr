export type PayPalEnvironment = 'sandbox' | 'live';
export type PayPalCredentials = { environment: PayPalEnvironment; clientId: string; clientSecret: string; version: number };
const ORIGINS: Record<PayPalEnvironment, string> = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class PayPalError extends Error {
  code: string;
  status: number;
  retryAfterMs: number | null;
  constructor(code: string, status = 502, retryAfterMs: number | null = null) {
    super(`PayPal operation failed (${code})`);
    this.code = code; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}
async function boundedJson(response: Response): Promise<any> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) throw new PayPalError('OVERSIZED');
  const reader = response.body?.getReader();
  if (!reader) throw new PayPalError('MALFORMED');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new PayPalError('OVERSIZED');
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new PayPalError('MALFORMED'); }
}
function pathWithId(prefix: string, id: string, suffix = ''): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new PayPalError('INVALID_ID', 400);
  return `${prefix}/${id}${suffix}`;
}

export class PayPalClient {
  private fetcher: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private tokens = new Map<string, { value: string; expires: number }>();
  private pending = new Map<string, Promise<string>>();
  constructor({ fetcher = fetch, now = Date.now, sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }:
    { fetcher?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.fetcher = fetcher; this.now = now; this.sleep = sleep;
  }
  invalidate() { this.tokens.clear(); this.pending.clear(); }
  private key(config: PayPalCredentials) { return `${config.environment}:${config.clientId}:${config.version}`; }
  private async raw(config: PayPalCredentials, path: string, init: RequestInit): Promise<any> {
    if (!/^\/[a-zA-Z0-9/_?=&.%-]+$/.test(path) || path.includes('..')) throw new PayPalError('INVALID_PATH', 400);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(`${ORIGINS[config.environment]}${path}`, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        const delay = Number(response.headers.get('retry-after'));
        throw new PayPalError(response.status === 401 || response.status === 403 ? 'CREDENTIALS_REQUIRED' : `HTTP_${response.status}`,
          response.status, response.status === 429 && Number.isFinite(delay) ? Math.min(delay * 1000, 60_000) : null);
      }
      if (response.status === 204) return {};
      return boundedJson(response);
    } catch (err) { if (err instanceof PayPalError) throw err; throw new PayPalError('NETWORK'); }
    finally { clearTimeout(timeout); }
  }
  private async token(config: PayPalCredentials): Promise<string> {
    const key = this.key(config);
    const cached = this.tokens.get(key);
    if (cached && cached.expires - 60_000 > this.now()) return cached.value;
    const existing = this.pending.get(key); if (existing) return existing;
    const promise = (async () => {
      const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
      const result = await this.raw(config, '/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
      if (typeof result.access_token !== 'string' || !Number.isFinite(Number(result.expires_in))) throw new PayPalError('MALFORMED');
      this.tokens.set(key, { value: result.access_token, expires: this.now() + Math.max(0, Number(result.expires_in)) * 1000 });
      return result.access_token as string;
    })();
    this.pending.set(key, promise);
    try { return await promise; } finally { if (this.pending.get(key) === promise) this.pending.delete(key); }
  }
  async request(config: PayPalCredentials, method: 'GET' | 'POST', path: string, body?: object, requestId?: string): Promise<any> {
    const token = await this.token(config);
    const init = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
      body: body ? JSON.stringify(body) : undefined };
    for (let attempt = 0; ; attempt++) {
      try { return await this.raw(config, path, init); }
      catch (err) {
        if (method !== 'GET' || !(err instanceof PayPalError) || ![429, 503].includes(err.status) || attempt >= 2) throw err;
        await this.sleep(Math.min(60_000, err.retryAfterMs ?? (attempt + 1) * 1000));
      }
    }
  }
  async createOrder(config: PayPalCredentials, amount: string, customId: string, requestId: string) {
    return this.request(config, 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'DKK', value: amount }, custom_id: customId }] }, requestId);
  }
  async getOrder(config: PayPalCredentials, id: string) { return this.request(config, 'GET', pathWithId('/v2/checkout/orders', id)); }
  async captureOrder(config: PayPalCredentials, id: string, requestId: string) { return this.request(config, 'POST', pathWithId('/v2/checkout/orders', id, '/capture'), {}, requestId); }
  async getRefund(config: PayPalCredentials, id: string) { return this.request(config, 'GET', pathWithId('/v2/payments/refunds', id)); }
  async listWebhookEvents(config: PayPalCredentials, from: Date, to: Date) {
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || !(from < to) ||
        to.getTime() - from.getTime() > 7 * 86_400_000) throw new PayPalError('INVALID_RANGE', 400);
    return this.request(config, 'GET', `/v1/notifications/webhooks-events?page_size=100&start_time=${encodeURIComponent(from.toISOString())}&end_time=${encodeURIComponent(to.toISOString())}`);
  }
  async listSubscriptionTransactions(config: PayPalCredentials, id: string, from: Date, to: Date) {
    if (!(from < to) || to.getTime() - from.getTime() > 30 * 86_400_000) throw new PayPalError('INVALID_RANGE', 400);
    const path = pathWithId('/v1/billing/subscriptions', id, '/transactions');
    return this.request(config, 'GET', `${path}?start_time=${encodeURIComponent(from.toISOString())}&end_time=${encodeURIComponent(to.toISOString())}`);
  }
  async getCapture(config: PayPalCredentials, id: string) { return this.request(config, 'GET', pathWithId('/v2/payments/captures', id)); }
  async createSubscription(config: PayPalCredentials, planId: string, customId: string, requestId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(planId)) throw new PayPalError('INVALID_ID', 400);
    return this.request(config, 'POST', '/v1/billing/subscriptions', { plan_id: planId, custom_id: customId }, requestId);
  }
  async getPlan(config: PayPalCredentials, id: string) { return this.request(config, 'GET', pathWithId('/v1/billing/plans', id)); }
  async getSubscription(config: PayPalCredentials, id: string) { return this.request(config, 'GET', pathWithId('/v1/billing/subscriptions', id)); }
  async cancelSubscription(config: PayPalCredentials, id: string, requestId: string) {
    return this.request(config, 'POST', pathWithId('/v1/billing/subscriptions', id, '/cancel'), { reason: 'Member requested cancellation' }, requestId);
  }
  async verifyWebhook(config: PayPalCredentials, webhookId: string, headers: Record<string, string | string[] | undefined>, rawEvent: Buffer): Promise<boolean> {
    const value = (key: string) => typeof headers[key] === 'string' ? headers[key] as string : '';
    const transmissionId = value('paypal-transmission-id'); const transmissionTime = value('paypal-transmission-time');
    const certUrl = value('paypal-cert-url'); const authAlgo = value('paypal-auth-algo'); const signature = value('paypal-transmission-sig');
    // The verification API performs cryptographic verification. Validate the certificate URL
    // anyway so the event cannot turn the verifier into a generic network fetch.
    let cert: URL;
    try { cert = new URL(certUrl); } catch { return false; }
    const allowedCertHosts = config.environment === 'sandbox' ? ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'] : ['api-m.paypal.com', 'api.paypal.com'];
    if (cert.protocol !== 'https:' || !allowedCertHosts.includes(cert.host) ||
        !/^\/v1\/notifications\/certs\/[A-Za-z0-9_-]+$/.test(cert.pathname) || cert.search || cert.hash ||
        !transmissionId || !transmissionTime || !signature || authAlgo !== 'SHA256withRSA' || !webhookId) return false;
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(rawEvent); JSON.parse(raw); } catch { return false; }
    const token = await this.token(config);
    const prefix = JSON.stringify({ transmission_id: transmissionId, transmission_time: transmissionTime, cert_url: cert.href,
      auth_algo: authAlgo, transmission_sig: signature, webhook_id: webhookId }).slice(0, -1);
    const result = await this.raw(config, '/v1/notifications/verify-webhook-signature', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: `${prefix},\"webhook_event\":${raw}}`,
    });
    return result.verification_status === 'SUCCESS';
  }
}
export const paypalClient = new PayPalClient();
