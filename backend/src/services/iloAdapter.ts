import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { isProhibitedManagementAddress } from '../utils/urlGuard.ts';

export type HardwareMode = 'low' | 'dynamic' | 'high' | 'os_control' | 'unknown';
export type OptionalCapability = 'supported' | 'unsupported' | 'unavailable';
export type HardwareHealth = {
  temperatures: { name: string; celsius: number | null; health: string | null }[];
  fans: { name: string; value: number | null; unit: 'percent' | 'rpm' | null; health: string | null }[];
  powerSupplies: { name: string; health: string | null; state: string | null }[];
  powerRedundancy: { health: string | null; state: string | null } | null;
  limited: boolean;
};
// `tlsFingerprint` pins the iLO's own certificate (SHA-256, colon-separated
// upper-case hex). It replaces CA verification: nothing else is trusted.
export type IloConfig = { host: string; port: number; username: string; password: string; verifyTls: boolean; caCertificate?: string | null; tlsFingerprint?: string | null };
export type IloTransport = (path: string) => Promise<Record<string, any>>;
// `etag` is the ComputerSystem's @odata.etag from the pre-write read, sent as
// If-Match when the iLO publishes one; a 412 means the resource changed.
export type RuntimePatchTransport = (path: string, oem: 'Hp' | 'Hpe', value: 'Min' | 'Dynamic' | 'Max', etag?: string | null) => Promise<void>;
// 'on' only when the host is powered and finished POST. Anything else is a
// safe refusal for writes; the controller never powers a host on.
export type HostPowerState = 'on' | 'off' | 'booting' | 'unknown';
export type IloNetworkDeps = { validateTarget?: typeof validateManagementTarget; request?: typeof https.request; requestDeadlineMs?: number; connect?: typeof tls.connect };

// The socket `timeout` only fires on idle sockets, so a device that drips one
// byte every few seconds could hold a request (and the collector lease) open
// indefinitely. Every request also has a wall-clock deadline, and one
// discovery has an overall deadline well below the 120 s collector lease.
export const ILO_REQUEST_DEADLINE_MS = 15_000;
// iLO 4 can sit silent for several seconds before answering heavier Redfish
// resources, so the idle limit is generous; the wall-clock deadline still bounds it.
export const ILO_SOCKET_IDLE_MS = 10_000;
export const ILO_DISCOVERY_DEADLINE_MS = 60_000;
export type HardwareDiscovery = {
  identity: { uuid: string | null; serial: string | null };
  model: string | null;
  generation: 'ilo4' | 'ilo5' | 'unknown';
  firmware: string | null;
  mode: { value: HardwareMode; origin: string | null };
  powerState?: HostPowerState;
  etag?: string | null;
  capabilities: { monitoring: 'supported' | 'unsupported'; runtimeMode: 'supported' | 'unsupported'; writePrivilege: 'unverified';
    temperatures?: OptionalCapability; fans?: OptionalCapability; powerSupplies?: OptionalCapability; powerRedundancy?: OptionalCapability };
  sample: { watts: number | null; origin: string | null; unit: 'W'; observedAt: string; health?: HardwareHealth };
};

function safeName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64) || fallback : fallback;
}
function safeStatus(value: unknown): string | null {
  return typeof value === 'string' && /^(OK|Warning|Critical|Unknown|Enabled|Disabled|Absent|Offline|Degraded|Failed|Redundant|NonRedundant)$/i.test(value) ? value : null;
}
function boundedNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

// Redfish iLO 4 and 5 use different names for several thermal properties.
// This projection deliberately excludes raw vendor payloads and identifiers.
export function normalizeHardwareHealth(thermal: any, power: any): HardwareHealth {
  const temperatures = Array.isArray(thermal?.Temperatures) ? thermal.Temperatures : [];
  const fans = Array.isArray(thermal?.Fans) ? thermal.Fans : [];
  const supplies = Array.isArray(power?.PowerSupplies) ? power.PowerSupplies : [];
  const redundancies = Array.isArray(power?.Redundancy) ? power.Redundancy : [];
  return {
    temperatures: temperatures.slice(0, 64).map((item: any, index: number) => ({
      name: safeName(item?.Name ?? item?.SensorName, `Temperature ${index + 1}`),
      celsius: item?.ReadingCelsius != null ? boundedNumber(item.ReadingCelsius, -40, 125)
        : item?.Units === 'Celsius' ? boundedNumber(item.CurrentReading, -40, 125) : null,
      health: safeStatus(item?.Status?.Health),
    })),
    fans: fans.slice(0, 32).map((item: any, index: number) => {
      const unit = item?.ReadingUnits === 'Percent' || item?.Units === 'Percent' ? 'percent' as const
        : item?.ReadingUnits === 'RPM' || item?.Units === 'RPM' || item?.ReadingRPM != null ? 'rpm' as const : null;
      const reading = item?.Reading ?? item?.CurrentReading ?? item?.ReadingRPM;
      return { name: safeName(item?.Name ?? item?.FanName, `Fan ${index + 1}`),
        value: unit ? boundedNumber(reading, 0, unit === 'percent' ? 100 : 50_000) : null,
        unit, health: safeStatus(item?.Status?.Health) };
    }),
    powerSupplies: supplies.slice(0, 16).map((item: any, index: number) => ({
      name: safeName(item?.Name ?? item?.MemberId, `Power supply ${index + 1}`),
      health: safeStatus(item?.Status?.Health ?? item?.Oem?.Hp?.PowerSupplyStatus?.State ?? item?.Oem?.Hpe?.PowerSupplyStatus?.State),
      state: safeStatus(item?.Status?.State),
    })),
    powerRedundancy: redundancies[0] ? { health: safeStatus(redundancies[0]?.Status?.Health), state: safeStatus(redundancies[0]?.Status?.State) } : null,
    limited: temperatures.length > 64 || fans.length > 32 || supplies.length > 16 || redundancies.length > 1,
  };
}

// iLO firmware may vary UUID letter case or pad a serial with whitespace.
// Persist one comparison form so identity checks survive those variations.
export function physicalSystemIdentity(identity: { uuid: string | null; serial: string | null }): string | null {
  const uuid = identity.uuid?.trim();
  if (uuid) return uuid.toLowerCase();
  const serial = identity.serial?.trim();
  return serial ? `serial:${serial.toLowerCase()}` : null;
}

export class IloError extends Error {
  code: 'invalid_target' | 'unreachable' | 'authentication_failed' | 'insufficient_privilege' | 'tls_failed' | 'timeout' | 'malformed_response' | 'oversized_response' | 'missing_endpoint'
    | 'host_not_running' | 'conflict' | 'policy_changed';
  // Operator-facing diagnosis (socket/TLS error code, HTTP status, Redfish
  // path). Never contains credentials or vendor payloads.
  detail?: string;
  constructor(code: IloError['code'], message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const SOCKET_DETAIL: Record<string, string> = {
  ECONNREFUSED: 'connection refused — nothing is listening on that port',
  EHOSTUNREACH: 'no route to host — the backend cannot reach this network',
  ENETUNREACH: 'network unreachable from the backend',
  ETIMEDOUT: 'TCP connection timed out — host down or traffic filtered',
  ECONNRESET: 'connection reset by the iLO',
  EPIPE: 'connection closed by the iLO',
  ENOTFOUND: 'host name could not be resolved',
  EAI_AGAIN: 'host name lookup failed temporarily',
};

export function isTlsErrorCode(code?: string) {
  return Boolean(code && (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.startsWith('CERT') || code === 'EPROTO'
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code.startsWith('UNABLE_TO_') || code === 'HOSTNAME_MISMATCH'));
}

// Maps a Node socket/TLS error to an IloError with a safe explanation.
export function classifyConnectionError(err: Error & { code?: string }, action: string): IloError {
  if (err instanceof IloError) return err;
  const code = typeof err.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(err.code) ? err.code : undefined;
  if (isTlsErrorCode(code)) return new IloError('tls_failed', `${action} failed`, `TLS handshake failed (${code})`);
  return new IloError('unreachable', `${action} failed`, code ? `${SOCKET_DETAIL[code] || 'connection failed'} (${code})` : 'connection failed');
}

export async function validateManagementTarget(host: string, resolver = dns.lookup): Promise<string> {
  const clean = String(host || '').trim();
  if (!clean || clean.length > 253 || (isIP(clean) !== 6 && /[\/:?#@\s]/.test(clean)) || clean.toLowerCase() === 'localhost') throw new IloError('invalid_target', 'Invalid management host');
  let addresses: string[];
  try { addresses = isIP(clean) ? [clean] : (await resolver(clean, { all: true, verbatim: true }) as { address: string }[]).map((x) => x.address); }
  catch (err) { const code = (err as { code?: string }).code; throw new IloError('unreachable', 'Management host could not be resolved', `host name could not be resolved${code && /^[A-Z_]{2,32}$/.test(code) ? ` (${code})` : ''}`); }
  if (!addresses.length || addresses.some(isProhibitedManagementAddress)) throw new IloError('invalid_target', 'Management target resolves to a prohibited address');
  return addresses[0];
}

const FINGERPRINT_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// Accepts "AB:CD:…", "ab cd …" or 64 bare hex digits; returns the canonical
// colon form Node reports as `fingerprint256`, or null when it is not one.
export function normalizeTlsFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  const value = hex.match(/.{2}/g)!.join(':');
  return FINGERPRINT_RE.test(value) ? value : null;
}

function assertTlsAllowed(config: IloConfig) {
  if (config.tlsFingerprint && !normalizeTlsFingerprint(config.tlsFingerprint)) throw new IloError('tls_failed', 'Invalid pinned certificate fingerprint', 'the stored certificate pin is not a SHA-256 fingerprint');
  if (!config.verifyTls && !config.tlsFingerprint && process.env.ALLOW_INSECURE_UPSTREAM_TLS !== 'true') {
    throw new IloError('tls_failed', 'Unverified iLO TLS requires ALLOW_INSECURE_UPSTREAM_TLS=true', 'TLS verification is off but the server does not allow unverified upstream TLS (ALLOW_INSECURE_UPSTREAM_TLS); pin the iLO certificate instead');
  }
}

// Opens the TLS socket for a pinned connection and hands it to the HTTP
// request only after the presented certificate matched the pin, so the Basic
// auth header is never written to an impostor.
function pinnedConnection(config: IloConfig, address: string, connect: typeof tls.connect) {
  const pin = normalizeTlsFingerprint(config.tlsFingerprint)!;
  return (_options: unknown, callback: (err: Error | null, socket: Duplex) => void) => {
    let done = false;
    // Node ignores the socket argument when an error is passed.
    const finish = (err: Error | null) => { if (done) return; done = true; callback(err, socket); };
    const socket = connect({ host: address, port: config.port, servername: isIP(config.host) ? undefined : config.host, rejectUnauthorized: false });
    socket.setTimeout(ILO_SOCKET_IDLE_MS, () => socket.destroy(new IloError('timeout', 'iLO TLS handshake timed out', `no TLS handshake from ${config.host}:${config.port} for ${ILO_SOCKET_IDLE_MS / 1000} s`)));
    socket.once('error', (err) => finish(err));
    socket.once('secureConnect', () => {
      const presented = socket.getPeerCertificate()?.fingerprint256 || null;
      if (presented !== pin) {
        const err = new IloError('tls_failed', 'iLO certificate does not match the pin', `certificate changed: the iLO presented SHA-256 ${presented || 'none'}, but ${pin} is pinned`);
        socket.destroy();
        return finish(err);
      }
      socket.setTimeout(0);
      finish(null);
    });
    return undefined;
  };
}

// TLS part of the request options for one iLO call.
function tlsRequestOptions(config: IloConfig, address: string, deps: IloNetworkDeps) {
  if (config.tlsFingerprint) {
    // One-off agent: its connections are opened by the pinning check, and no
    // socket is pooled or reused across configurations.
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    (agent as unknown as { createConnection: unknown }).createConnection = pinnedConnection(config, address, deps.connect || tls.connect);
    return { agent };
  }
  return { rejectUnauthorized: config.verifyTls, ca: config.caCertificate || undefined, lookup: (_host: string, _options: unknown, callback: (err: Error | null, address: string, family: number) => void) => callback(null, address, isIP(address)) };
}

export type CertificateProbe = { fingerprint256: string; subject: string | null; issuer: string | null; validFrom: string | null; validTo: string | null; selfSigned: boolean };

// Reads the certificate an iLO presents so an admin can confirm and pin it.
// Sends no credentials and no HTTP request: it completes a TLS handshake and
// closes the socket.
export async function probeIloCertificate(host: string, port: number, deps: IloNetworkDeps = {}): Promise<CertificateProbe> {
  const address = await (deps.validateTarget || validateManagementTarget)(host);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new IloError('invalid_target', 'Invalid management port');
  const connect = deps.connect || tls.connect;
  const deadlineMs = deps.requestDeadlineMs ?? ILO_REQUEST_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false });
    const deadline = setTimeout(() => socket.destroy(new IloError('timeout', 'iLO TLS handshake timed out', `no TLS handshake from ${host}:${port} within ${Math.round(deadlineMs / 1000)} s`)), deadlineMs);
    deadline.unref?.();
    socket.once('error', (err) => { clearTimeout(deadline); reject(classifyConnectionError(err, 'iLO certificate probe')); });
    socket.once('secureConnect', () => {
      clearTimeout(deadline);
      const cert = socket.getPeerCertificate();
      socket.end();
      const fingerprint256 = normalizeTlsFingerprint(cert?.fingerprint256);
      if (!fingerprint256) return reject(new IloError('tls_failed', 'iLO presented no certificate', 'the iLO completed TLS without a usable certificate'));
      const name = (part: unknown) => {
        const cn = (part as Record<string, unknown> | undefined)?.CN;
        const value = Array.isArray(cn) ? cn[0] : cn;
        return typeof value === 'string' ? value.slice(0, 200) : null;
      };
      resolve({ fingerprint256, subject: name(cert.subject), issuer: name(cert.issuer), validFrom: cert.valid_from || null, validTo: cert.valid_to || null,
        selfSigned: JSON.stringify(cert.subject) === JSON.stringify(cert.issuer) });
    });
  });
}

export async function createIloTransport(config: IloConfig, deps: IloNetworkDeps = {}): Promise<IloTransport> {
  const address = await (deps.validateTarget || validateManagementTarget)(config.host);
  const request = deps.request || https.request;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new IloError('invalid_target', 'Invalid management port');
  assertTlsAllowed(config);
  const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  const deadlineMs = deps.requestDeadlineMs ?? ILO_REQUEST_DEADLINE_MS;
  return (path) => new Promise((resolve, reject) => {
    if (!/^\/(?:redfish|rest)\/v1(?:\/|$)/.test(path) || path.includes('..') || path.includes('?') || path.includes('#')) return reject(new IloError('invalid_target', 'Invalid iLO resource path'));
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(deadline); fn(); };
    const fail = (err: IloError) => finish(() => reject(err));
    const req = request({ hostname: config.host, port: config.port, path, method: 'GET', timeout: ILO_SOCKET_IDLE_MS, ...tlsRequestOptions(config, address, deps), headers: { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' } }, (res) => {
      // 401 is a rejected credential (counts towards iLO lockout); 403 is an
      // authenticated account that lacks read privilege for this resource.
      if (res.statusCode === 401) { res.resume(); return fail(new IloError('authentication_failed', 'iLO authentication failed', `HTTP 401 on ${path}`)); }
      if (res.statusCode === 403) { res.resume(); return fail(new IloError('insufficient_privilege', 'iLO account lacks read privilege', `HTTP 403 on ${path}`)); }
      if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400) { res.resume(); return fail(new IloError('invalid_target', 'iLO redirect refused', `HTTP ${res.statusCode} redirect on ${path} was refused`)); }
      if (res.statusCode === 404) { res.resume(); return fail(new IloError('missing_endpoint', 'iLO resource unavailable', `HTTP 404 on ${path}`)); }
      if (res.statusCode !== 200) { res.resume(); return fail(new IloError('unreachable', 'iLO request failed', `HTTP ${res.statusCode} on ${path}`)); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { if (settled) return; size += chunk.length; if (size > 1024 * 1024) { req.destroy(new IloError('oversized_response', 'iLO response exceeded limit', `response from ${path} exceeded 1 MiB`)); return; } chunks.push(chunk); });
      res.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); finish(() => resolve(value)); } catch { fail(new IloError('malformed_response', 'Invalid iLO JSON response', `response from ${path} was not a JSON object`)); } });
    });
    const deadline = setTimeout(() => { const err = new IloError('timeout', 'iLO request exceeded its deadline', `no complete answer from ${path} within ${Math.round(deadlineMs / 1000)} s`); req.destroy(err); fail(err); }, deadlineMs);
    deadline.unref?.();
    req.on('timeout', () => req.destroy(new IloError('timeout', 'iLO request timed out', `no answer from ${config.host}:${config.port} for ${ILO_SOCKET_IDLE_MS / 1000} s — host down, wrong port or traffic filtered`)));
    req.on('error', (err: Error & { code?: string }) => fail(classifyConnectionError(err, 'iLO connection')));
    req.end();
  });
}

// Bounds the whole discovery, not just each request: a series of individually
// slow (but in-deadline) reads must still release the collector lease in time.
export function withDiscoveryDeadline(transport: IloTransport, deadlineMs = ILO_DISCOVERY_DEADLINE_MS, clock = () => Date.now()): IloTransport {
  const expiresAt = clock() + deadlineMs;
  return (path) => {
    const remaining = expiresAt - clock();
    if (remaining <= 0) return Promise.reject(new IloError('timeout', 'iLO discovery exceeded its deadline', `discovery took longer than ${Math.round(deadlineMs / 1000)} s`));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new IloError('timeout', 'iLO discovery exceeded its deadline', `discovery took longer than ${Math.round(deadlineMs / 1000)} s`)), remaining);
      timer.unref?.();
    });
    return Promise.race([transport(path), expired]).finally(() => clearTimeout(timer));
  };
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
export function normalizeHostPowerState(system: any, oem: 'Hp' | 'Hpe' | null): HostPowerState {
  const power = system?.PowerState;
  const post = oem ? system?.Oem?.[oem]?.PostState : undefined;
  if (power === 'Off' || power === 'PoweringOff' || post === 'PowerOff') return 'off';
  if (power === 'PoweringOn' || post === 'InPost' || post === 'InPostDiscoveryComplete' || post === 'Reset') return 'booting';
  if (power === 'On' && (post === undefined || post === 'FinishedPost')) return 'on';
  return 'unknown';
}
export async function discoverHardware(config: IloConfig, injectedTransport?: IloTransport, now = () => new Date(), deadlineMs = ILO_DISCOVERY_DEADLINE_MS): Promise<HardwareDiscovery> {
  const get = withDiscoveryDeadline(injectedTransport || await createIloTransport(config), deadlineMs);
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
  const thermalPath = link(chassis?.value?.Thermal);
  let watts: number | null = null; let origin: string | null = null;
  let power: Record<string, any> | null = null;
  if (powerPath) {
    power = await get(powerPath);
    const direct = power.PowerConsumedWatts;
    const control = Array.isArray(power.PowerControl) ? power.PowerControl.find((x: any) => typeof x?.PowerConsumedWatts === 'number') : null;
    const measured = typeof direct === 'number' ? direct : control?.PowerConsumedWatts;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) { watts = measured; origin = `${powerPath}${typeof direct === 'number' ? '#PowerConsumedWatts' : '#PowerControl.PowerConsumedWatts'}`; }
  }
  let thermal: Record<string, any> | null = null;
  let thermalStatus: OptionalCapability = 'unsupported';
  if (thermalPath) {
    try { thermal = await get(thermalPath); thermalStatus = 'supported'; }
    catch (err) { thermalStatus = err instanceof IloError && err.code === 'missing_endpoint' ? 'unsupported' : 'unavailable'; }
  }
  const health = normalizeHardwareHealth(thermal, power);
  const managerType = `${manager?.value?.Model || ''} ${manager?.value?.Name || ''}`;
  const generation = /iLO\s*5/i.test(managerType) || oem === 'Hpe' ? 'ilo5' : /iLO\s*4/i.test(managerType) || oem === 'Hp' ? 'ilo4' : 'unknown';
  return {
    identity: { uuid: typeof system.value.UUID === 'string' ? system.value.UUID : null, serial: typeof system.value.SerialNumber === 'string' ? system.value.SerialNumber : null },
    model: typeof system.value.Model === 'string' ? system.value.Model : null,
    generation,
    firmware: manager?.value?.FirmwareVersion || null,
    mode: { value: normalizeMode(rawMode), origin: oem ? `${system.path}#Oem.${oem}.PowerRegulatorMode` : null },
    powerState: normalizeHostPowerState(system.value, oem),
    // Only a strong entity tag is usable with If-Match (RFC 9110 strong
    // comparison); weak W/ tags are ignored rather than guaranteed to fail.
    etag: typeof system.value['@odata.etag'] === 'string' && /^"[\x21\x23-\x7e]{1,200}"$/.test(system.value['@odata.etag']) ? system.value['@odata.etag'] : null,
    capabilities: { monitoring: watts === null ? 'unsupported' : 'supported', runtimeMode: oem ? 'supported' : 'unsupported', writePrivilege: 'unverified',
      temperatures: thermalStatus === 'supported' && !Array.isArray(thermal?.Temperatures) ? 'unsupported' : thermalStatus,
      fans: thermalStatus === 'supported' && !Array.isArray(thermal?.Fans) ? 'unsupported' : thermalStatus,
      powerSupplies: Array.isArray(power?.PowerSupplies) ? 'supported' : 'unsupported',
      powerRedundancy: Array.isArray(power?.Redundancy) ? 'supported' : 'unsupported' },
    sample: { watts, origin, unit: 'W', observedAt: now().toISOString(), health },
  };
}
export async function readCurrentMode(config: IloConfig, transport?: IloTransport): Promise<HardwareMode> {
  return (await discoverHardware(config, transport)).mode.value;
}

export type RuntimeState = { mode: HardwareMode; powerState: HostPowerState };
// Read-only: mode plus host power state, used before any write decision.
export async function readRuntimeState(config: IloConfig, transport?: IloTransport): Promise<RuntimeState> {
  const discovery = await discoverHardware(config, transport);
  return { mode: discovery.mode.value, powerState: discovery.powerState ?? 'unknown' };
}

const RUNTIME_VALUES = { low: 'Min', dynamic: 'Dynamic', high: 'Max' } as const;

// This is the only hardware write primitive for the power feature. The path
// must come from discovery's ComputerSystem link, and the JSON body contains
// exactly one PowerRegulatorMode property. No reset, BIOS or watt-cap API is
// available through this interface.
export async function createRuntimePatchTransport(config: IloConfig, deps: IloNetworkDeps = {}): Promise<RuntimePatchTransport> {
  const address = await (deps.validateTarget || validateManagementTarget)(config.host);
  const request = deps.request || https.request;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new IloError('invalid_target', 'Invalid management port');
  assertTlsAllowed(config);
  const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  return (path, oem, value, etag) => new Promise((resolve, reject) => {
    if (!/^\/(?:redfish|rest)\/v1\/Systems\/[^/?#]+\/?$/.test(path) || path.includes('..')
      || !['Hp', 'Hpe'].includes(oem) || !['Min', 'Dynamic', 'Max'].includes(value)
      || (etag != null && !/^"[\x21\x23-\x7e]{1,200}"$/.test(etag))) {
      return reject(new IloError('invalid_target', 'Invalid runtime mode target'));
    }
    const body = JSON.stringify({ Oem: { [oem]: { PowerRegulatorMode: value } } });
    const req = request({
      hostname: config.host, port: config.port, path, method: 'PATCH', timeout: 5000,
      ...tlsRequestOptions(config, address, deps),
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body), 'OData-Version': '4.0', ...(etag ? { 'If-Match': etag } : {}) },
    }, (res) => {
      let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) req.destroy(new IloError('oversized_response', 'iLO response exceeded limit')); });
      res.on('end', () => {
        clearTimeout(deadline);
        if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) resolve();
        else if (res.statusCode === 401) reject(new IloError('authentication_failed', 'iLO authentication failed'));
        else if (res.statusCode === 403) reject(new IloError('insufficient_privilege', 'iLO write permission denied'));
        else if (res.statusCode === 412) reject(new IloError('conflict', 'iLO system changed before the mode request (ETag mismatch)'));
        else if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400) reject(new IloError('invalid_target', 'iLO redirect refused'));
        else reject(new IloError('unreachable', 'iLO runtime mode request failed'));
      });
    });
    // A wall-clock deadline maps to `timeout`, which callers already treat as
    // an uncertain outcome that needs a read-back before any retry.
    const deadline = setTimeout(() => req.destroy(new IloError('timeout', 'iLO mode request exceeded its deadline')), deps.requestDeadlineMs ?? ILO_REQUEST_DEADLINE_MS);
    deadline.unref?.();
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new IloError('timeout', 'iLO mode request timed out')));
    req.on('error', (err: Error & { code?: string }) => reject(classifyConnectionError(err, 'iLO mode connection')));
    req.end(body);
  });
}

export type RuntimeWriteOptions = {
  // Bounded readback: HTTP success is not verified success.
  readbackAttempts?: number;
  readbackDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });

export async function setRuntimeMode(
  config: IloConfig,
  target: 'low' | 'dynamic' | 'high',
  readTransport?: IloTransport,
  patchTransport?: RuntimePatchTransport,
  preDispatchGuard?: () => Promise<boolean>,
  options: RuntimeWriteOptions = {},
): Promise<{ prior: HardwareMode; target: typeof target; outcome: 'already_set' | 'verified' | 'unknown' }> {
  if (!Object.hasOwn(RUNTIME_VALUES, target)) throw new IloError('invalid_target', 'Unsupported runtime power mode');
  const before = await discoverHardware(config, readTransport);
  if (before.mode.value === 'os_control' || before.mode.value === 'unknown'
    || before.capabilities.runtimeMode !== 'supported' || !before.mode.origin) {
    throw new IloError('missing_endpoint', 'Runtime Power Regulator mode is unavailable');
  }
  // Never act on a host that is off, booting or in an unknown power state.
  if ((before.powerState ?? 'unknown') !== 'on') throw new IloError('host_not_running', 'Host is not powered on and finished booting');
  if (before.mode.value === target) return { prior: before.mode.value, target, outcome: 'already_set' };
  const [path, property] = before.mode.origin.split('#');
  const oem = property === 'Oem.Hp.PowerRegulatorMode' ? 'Hp'
    : property === 'Oem.Hpe.PowerRegulatorMode' ? 'Hpe' : null;
  if (!oem || !/^\/(?:redfish|rest)\/v1\/Systems\/[^/?#]+\/?$/.test(path)) {
    throw new IloError('missing_endpoint', 'Runtime Power Regulator target was not discovered');
  }
  if (preDispatchGuard && !await preDispatchGuard()) {
    throw new IloError('policy_changed', 'Power policy changed before dispatch');
  }
  const patch = patchTransport ?? await createRuntimePatchTransport(config);
  let timedOut = false;
  try { await patch(path, oem, RUNTIME_VALUES[target], before.etag ?? null); }
  catch (err) {
    // A transport timeout may mean the device applied the PATCH. It is never
    // retried here; a bounded read decides between verified and unknown.
    if (!(err instanceof IloError && err.code === 'timeout')) throw err;
    timedOut = true;
  }
  const attempts = Math.max(1, Math.min(options.readbackAttempts ?? 3, 6));
  const delay = Math.max(0, Math.min(options.readbackDelayMs ?? 2000, 10_000));
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 || timedOut) await sleep(delay);
    try {
      if (await readCurrentMode(config, readTransport) === target) return { prior: before.mode.value, target, outcome: 'verified' };
    } catch { /* readback failure keeps the outcome unknown */ }
  }
  return { prior: before.mode.value, target, outcome: 'unknown' };
}
