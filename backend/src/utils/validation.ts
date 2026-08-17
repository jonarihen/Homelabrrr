import net from 'node:net';

export const PASSWORD_MIN_LENGTH = 12;
export const USERNAME_MAX_LENGTH = 64;

export class ValidationError extends Error {
  status: number;
  code: string;
  field: string;

  constructor(message: string, { field = '', code = 'VALIDATION_ERROR' }: { field?: string; code?: string } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = code;
    this.field = field;
  }
}

export interface BoundedStringOptions {
  field?: string;
  min?: number;
  max?: number;
  trim?: boolean;
  pattern?: RegExp | null;
}

export function boundedString(value: unknown, {
  field = 'value', min = 0, max = 255, trim = true, pattern = null,
}: BoundedStringOptions = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, { field });
  const result = trim ? value.trim() : value;
  if (result.length < min) throw new ValidationError(`${field} must be at least ${min} characters`, { field });
  if (result.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`, { field });
  if (pattern && !pattern.test(result)) throw new ValidationError(`${field} has an invalid format`, { field });
  return result;
}

export function boundedInteger(value: unknown, { field = 'value', min = 0, max = Number.MAX_SAFE_INTEGER }: { field?: string; min?: number; max?: number } = {}): number {
  if (typeof value === 'string' && !/^-?\d+$/.test(value.trim())) {
    throw new ValidationError(`${field} must be an integer`, { field });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`, { field });
  }
  return parsed;
}

export function validatePort(value: unknown, field = 'port'): number {
  return boundedInteger(value, { field, min: 1, max: 65535 });
}

export function validateVmid(value: unknown, field = 'vmid'): number {
  return boundedInteger(value, { field, min: 100, max: 999_999_999 });
}

export function validateVlanTag(value: unknown, field = 'vlan'): number {
  return boundedInteger(value, { field, min: 1, max: 4094 });
}

export function validateIp(value: unknown, field = 'ip'): string {
  const candidate = boundedString(value, { field, min: 1, max: 45 });
  if (!net.isIP(candidate)) throw new ValidationError(`${field} must be a valid IPv4 or IPv6 address`, { field });
  return candidate;
}

export function validateHttpUrl(value: unknown, field = 'url'): string {
  const candidate = boundedString(value, { field, min: 1, max: 2048 });
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new ValidationError(`${field} must be a valid URL`, { field }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ValidationError(`${field} must be an HTTP(S) URL without embedded credentials`, { field });
  }
  return parsed.toString();
}

export function validateObject<T extends Record<string, unknown>>(value: unknown, { fields, required = [] }: { fields?: string[]; required?: string[] } = {}): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('request body must be a JSON object', { field: 'body' });
  }
  const allowed = new Set(fields || []);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new ValidationError(`Unexpected field: ${unexpected[0]}`, { field: unexpected[0], code: 'UNEXPECTED_FIELD' });
  for (const field of required) {
    if (!(field in value)) throw new ValidationError(`Missing required field: ${field}`, { field, code: 'MISSING_FIELD' });
  }
  return value as T;
}

export function validateUsername(value: unknown): string {
  return boundedString(value, {
    field: 'username', min: 3, max: USERNAME_MAX_LENGTH, pattern: /^[A-Za-z0-9._-]+$/,
  });
}

export function validatePassword(value: unknown, field = 'password'): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, { field });
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`${field} must be at least ${PASSWORD_MIN_LENGTH} characters`, { field });
  }
  if (value.length > 1024) throw new ValidationError(`${field} is too long`, { field });
  return value;
}

export function validateHost(value: unknown): string {
  const host = boundedString(value, { field: 'host', min: 1, max: 253 }).toLowerCase();
  if (net.isIP(host)) return host;
  if (host === 'localhost' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new ValidationError('host must be a valid IP address or DNS hostname', { field: 'host' });
  }
  return host;
}

export function validationErrorPayload(err: unknown): { error: string; code: string; field?: string } {
  const e = err as Partial<ValidationError> | null;
  return {
    error: e?.message || 'Invalid request',
    code: e?.code || 'VALIDATION_ERROR',
    ...(e?.field ? { field: e.field } : {}),
  };
}
