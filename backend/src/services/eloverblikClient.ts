const ORIGIN = 'https://api.eloverblik.dk';
const BASE = '/customerapi/api';
const MAX_BYTES = 4 * 1024 * 1024;
const ACCESS_SAFETY_MS = 10 * 60_000;

type FetchLike = typeof fetch;
type Access = { value: string; expires: number; generation: number };

export class ElOverblikError extends Error {
  code: string;
  retryAfterMs: number | null;
  constructor(code: string, retryAfterMs: number | null = null) {
    super(`ElOverblik request failed (${code})`);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function dataShape(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ElOverblikError('MALFORMED');
  return body as Record<string, any>;
}

async function readJson(response: Response): Promise<Record<string, any>> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new ElOverblikError('OVERSIZED');
  const reader = response.body?.getReader();
  if (!reader) throw new ElOverblikError('MALFORMED');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new ElOverblikError('OVERSIZED');
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return dataShape(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))); }
  catch (err) { if (err instanceof ElOverblikError) throw err; throw new ElOverblikError('MALFORMED'); }
}

function tokenExpiry(token: string, now: number): number {
  // JWT exp is used solely for local cache expiry. Claims are never logged or trusted as authorization.
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString());
    if (Number.isFinite(payload.exp)) return Math.min(now + 24 * 60 * 60_000, payload.exp * 1000);
  } catch { /* Published maximum remains the fallback. */ }
  return now + 24 * 60 * 60_000;
}

export class ElOverblikClient {
  private fetcher: FetchLike;
  private now: () => number;
  private access: Access | null = null;
  private pending: Promise<Access> | null = null;
  private generation = 0;
  constructor({ fetcher = fetch, now = Date.now }: { fetcher?: FetchLike; now?: () => number } = {}) {
    this.fetcher = fetcher;
    this.now = now;
  }
  invalidate() { this.generation++; this.access = null; this.pending = null; }
  private async request(path: string, bearer: string, body?: object): Promise<Record<string, any>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(`${ORIGIN}${BASE}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', 'api-version': '1.0', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new ElOverblikError(response.status === 401 || response.status === 403 ? 'RECONNECT_REQUIRED' : `HTTP_${response.status}`,
          response.status === 429 && Number.isFinite(seconds) ? Math.min(seconds * 1000, 60_000) : null);
      }
      return readJson(response);
    } catch (err) {
      if (err instanceof ElOverblikError) throw err;
      throw new ElOverblikError('NETWORK');
    } finally { clearTimeout(timeout); }
  }
  private async getAccess(refreshToken: string): Promise<Access> {
    if (this.access && this.access.expires - ACCESS_SAFETY_MS > this.now()) return this.access;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = (async () => {
      const envelope = await this.request('/token', refreshToken);
      const result = envelope.result;
      if (typeof result !== 'string' || !result) throw new ElOverblikError('RECONNECT_REQUIRED');
      const access = { value: result, expires: tokenExpiry(result, this.now()), generation };
      if (generation !== this.generation) throw new ElOverblikError('CONFIG_CHANGED');
      this.access = access;
      return access;
    })();
    this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = null; }
  }
  private async authorized(path: string, refreshToken: string, body?: object): Promise<Record<string, any>> {
    let access = await this.getAccess(refreshToken);
    try { return await this.request(path, access.value, body); }
    catch (err) {
      if (!(err instanceof ElOverblikError) || err.code !== 'RECONNECT_REQUIRED') throw err;
      if (access.generation !== this.generation) throw new ElOverblikError('CONFIG_CHANGED');
      this.access = null;
      access = await this.getAccess(refreshToken);
      return this.request(path, access.value, body);
    }
  }
  async listMeters(refreshToken: string): Promise<Array<{ id: string; hasRelation: boolean; type: string }>> {
    const envelope = await this.authorized('/meteringpoints/meteringpoints?includeAll=false', refreshToken);
    if (!Array.isArray(envelope.result)) throw new ElOverblikError('MALFORMED');
    return envelope.result.map((item: any) => ({ id: String(item.meteringPointId || ''), hasRelation: item.hasRelation === true, type: String(item.typeOfMP || '') }))
      .filter((item: any) => /^\d{18}$/.test(item.id));
  }
  async timeSeries(refreshToken: string, meterId: string, from: string, to: string): Promise<Record<string, any>> {
    if (!/^\d{18}$/.test(meterId) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from >= to) throw new ElOverblikError('INVALID_REQUEST');
    return this.authorized(`/meterdata/gettimeseries/${from}/${to}/Actual`, refreshToken, { meteringPoints: { meteringPoint: [meterId] } });
  }
  async charges(refreshToken: string, meterId: string): Promise<Record<string, any>> {
    if (!/^\d{18}$/.test(meterId)) throw new ElOverblikError('INVALID_REQUEST');
    return this.authorized('/meteringpoints/meteringpoint/getcharges', refreshToken, { meteringPoints: { meteringPoint: [meterId] } });
  }
}

export const eloverblikClient = new ElOverblikClient();
