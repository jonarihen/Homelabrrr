import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';

export type HardwareMode = 'low' | 'dynamic' | 'high' | 'os_control' | 'unknown';
export type IloConfig = { host: string; port: number; username: string; password: string; verifyTls: boolean; caCertificate?: string | null };
export type IloTransport = (path: string) => Promise<Record<string, any>>;
export type HardwareDiscovery = {
  identity: { uuid: string | null; serial: string | null };
  model: string | null;
  generation: 'ilo4' | 'ilo5' | 'unknown';
  firmware: string | null;
  mode: { value: HardwareMode; origin: string | null };
  capabilities: { monitoring: 'supported' | 'unsupported'; runtimeMode: 'supported' | 'unsupported'; writePrivilege: 'unverified' };
  sample: { watts: number | null; origin: string | null; unit: 'W'; observedAt: string };
};

export class IloError extends Error {
  code: 'invalid_target' | 'unreachable' | 'authentication_failed' | 'tls_failed' | 'timeout' | 'malformed_response' | 'oversized_response' | 'missing_endpoint';
  constructor(code: IloError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

function safeAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (isIP(a) === 4) {
    const p = a.split('.').map(Number);
    return p[0] !== 0 && p[0] !== 127 && !(p[0] === 169 && p[1] === 254) && !(p[0] === 100 && p[1] === 100) && p[0] < 224;
  }
  if (isIP(a) === 6) return a !== '::' && a !== '::1' && !/^fe[89ab]/.test(a) && !a.startsWith('::ffff:127.') && !a.startsWith('::ffff:169.254.');
  return false;
}

export async function validateManagementTarget(host: string, resolver = dns.lookup): Promise<string> {
  const clean = String(host || '').trim();
  if (!clean || clean.length > 253 || (isIP(clean) !== 6 && /[\/:?#@\s]/.test(clean)) || clean.toLowerCase() === 'localhost') throw new IloError('invalid_target', 'Invalid management host');
  let addresses: string[];
  try { addresses = isIP(clean) ? [clean] : (await resolver(clean, { all: true, verbatim: true }) as { address: string }[]).map((x) => x.address); }
  catch { throw new IloError('unreachable', 'Management host could not be resolved'); }
  if (!addresses.length || addresses.some((a) => !safeAddress(a))) throw new IloError('invalid_target', 'Management target resolves to a prohibited address');
  return addresses[0];
}

export async function createIloTransport(config: IloConfig): Promise<IloTransport> {
  const address = await validateManagementTarget(config.host);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new IloError('invalid_target', 'Invalid management port');
  if (!config.verifyTls && process.env.ALLOW_INSECURE_UPSTREAM_TLS !== 'true') throw new IloError('tls_failed', 'Unverified iLO TLS requires ALLOW_INSECURE_UPSTREAM_TLS=true');
  const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  return (path) => new Promise((resolve, reject) => {
    if (!/^\/(?:redfish|rest)\/v1(?:\/|$)/.test(path) || path.includes('..') || path.includes('?') || path.includes('#')) return reject(new IloError('invalid_target', 'Invalid iLO resource path'));
    const req = https.request({ hostname: config.host, port: config.port, path, method: 'GET', timeout: 5000, rejectUnauthorized: config.verifyTls, ca: config.caCertificate || undefined, lookup: (_host, _options, callback) => callback(null, address, isIP(address)), headers: { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' } }, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); return reject(new IloError('authentication_failed', 'iLO authentication or read permission failed')); }
      if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400) { res.resume(); return reject(new IloError('invalid_target', 'iLO redirect refused')); }
      if (res.statusCode === 404) { res.resume(); return reject(new IloError('missing_endpoint', 'iLO resource unavailable')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new IloError('unreachable', 'iLO request failed')); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) { req.destroy(new IloError('oversized_response', 'iLO response exceeded limit')); return; } chunks.push(chunk); });
      res.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); resolve(value); } catch { reject(new IloError('malformed_response', 'Invalid iLO JSON response')); } });
    });
    req.on('timeout', () => req.destroy(new IloError('timeout', 'iLO request timed out')));
    req.on('error', (err: Error & { code?: string }) => reject(err instanceof IloError ? err : new IloError(err.code?.startsWith('ERR_TLS') || err.code?.startsWith('CERT') ? 'tls_failed' : 'unreachable', 'iLO connection failed')));
    req.end();
  });
}

function link(value: any): string | null {
  const path = value?.['@odata.id'] ?? value?.href;
  return typeof path === 'string' && /^\/(?:redfish|rest)\/v1\//.test(path) && !path.includes('..') && !path.includes('?') ? path : null;
}
async function firstMember(transport: IloTransport, collection: any): Promise<{ path: string; value: any } | null> {
  const collectionPath = link(collection);
  if (!collectionPath) return null;
  const data = await transport(collectionPath);
  const path = link(data.Members?.[0]);
  return path ? { path, value: await transport(path) } : null;
}
export function normalizeMode(value: unknown): HardwareMode {
  if (value === 'Min') return 'low';
  if (value === 'Dynamic') return 'dynamic';
  if (value === 'Max') return 'high';
  if (value === 'OSControl') return 'os_control';
  return 'unknown';
}
export async function discoverHardware(config: IloConfig, injectedTransport?: IloTransport, now = () => new Date()): Promise<HardwareDiscovery> {
  const get = injectedTransport || await createIloTransport(config);
  let root: any;
  try { root = await get('/redfish/v1/'); }
  catch (err) { if (!(err instanceof IloError) || err.code !== 'missing_endpoint') throw err; root = await get('/rest/v1/'); }
  const system = await firstMember(get, root.Systems);
  if (!system) throw new IloError('missing_endpoint', 'No iLO computer system found');
  const chassis = await firstMember(get, root.Chassis);
  const manager = await firstMember(get, root.Managers);
  const oem = system.value.Oem?.Hpe ? 'Hpe' : system.value.Oem?.Hp ? 'Hp' : null;
  const rawMode = oem ? system.value.Oem[oem]?.PowerRegulatorMode : undefined;
  const powerPath = link(chassis?.value?.Power);
  let watts: number | null = null; let origin: string | null = null;
  if (powerPath) {
    const power = await get(powerPath);
    const direct = power.PowerConsumedWatts;
    const control = Array.isArray(power.PowerControl) ? power.PowerControl.find((x: any) => typeof x?.PowerConsumedWatts === 'number') : null;
    const measured = typeof direct === 'number' ? direct : control?.PowerConsumedWatts;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) { watts = measured; origin = `${powerPath}${typeof direct === 'number' ? '#PowerConsumedWatts' : '#PowerControl.PowerConsumedWatts'}`; }
  }
  const managerType = `${manager?.value?.Model || ''} ${manager?.value?.Name || ''}`;
  const generation = /iLO\s*5/i.test(managerType) || oem === 'Hpe' ? 'ilo5' : /iLO\s*4/i.test(managerType) || oem === 'Hp' ? 'ilo4' : 'unknown';
  return {
    identity: { uuid: typeof system.value.UUID === 'string' ? system.value.UUID : null, serial: typeof system.value.SerialNumber === 'string' ? system.value.SerialNumber : null },
    model: typeof system.value.Model === 'string' ? system.value.Model : null,
    generation,
    firmware: manager?.value?.FirmwareVersion || null,
    mode: { value: normalizeMode(rawMode), origin: oem ? `${system.path}#Oem.${oem}.PowerRegulatorMode` : null },
    capabilities: { monitoring: watts === null ? 'unsupported' : 'supported', runtimeMode: oem ? 'supported' : 'unsupported', writePrivilege: 'unverified' },
    sample: { watts, origin, unit: 'W', observedAt: now().toISOString() },
  };
}
export async function readCurrentMode(config: IloConfig, transport?: IloTransport): Promise<HardwareMode> {
  return (await discoverHardware(config, transport)).mode.value;
}
