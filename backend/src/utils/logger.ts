import crypto from 'node:crypto';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passphrase|ticket|private.?key|totp|recovery.?code)/i;
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
let consoleRedactionInstalled = false;

export function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: value.code };
  }
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, seen);
  }
  return result;
}

export function redactText(value) {
  return String(value || '')
    .replace(/(PVEAPIToken=)[^\s"']+/gi, `$1${REDACTED}`)
    .replace(/(vmmgr-token-)[A-Za-z0-9._~+\/-]+/gi, `$1${REDACTED}`)
    .replace(/([?&](?:vncticket|token|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, `$1${REDACTED}`)
    .replace(/((?:authorization|cookie|token|secret|password|passphrase|ticket|private.?key|totp|recovery.?code)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .slice(0, 4096);
}

export function log(level, event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
  };
  const line = JSON.stringify(record);
  if (level === 'error') originalConsole.error(line);
  else if (level === 'warn') originalConsole.warn(line);
  else originalConsole.log(line);
}

export function installConsoleRedaction() {
  if (consoleRedactionInstalled) return;
  consoleRedactionInstalled = true;
  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => {
      const message = args.map((arg) => {
        const safe = typeof arg === 'string' ? redactText(arg) : redact(arg);
        return typeof safe === 'string' ? safe : JSON.stringify(safe);
      }).join(' ');
      log(method === 'error' ? 'error' : method === 'warn' ? 'warn' : 'info', 'legacy_console', { message });
    };
  }
}

export function requestContext(req, res, next) {
  const requestId = /^[A-Za-z0-9._-]{8,128}$/.test(String(req.headers['x-request-id'] || ''))
    ? String(req.headers['x-request-id'])
    : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
