import { isIP } from 'net';

function isReservedIPv4(ip: string) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||// benchmarking 198.18/15
    a >= 224
  );
}

function isReservedIPv6(ip: string) {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isReservedIPv4(dotted[1]);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isReservedIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (lower === '::' || lower === '::1') return true;
  return /^(fc|fd|fe[89ab]|fe[c-f])/.test(lower);
}

export function isReservedAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return isReservedIPv4(address);
  if (version === 6) return isReservedIPv6(address);
  return true;
}
