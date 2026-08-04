import net from 'node:net';

function ipv4Number(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

export function ipv4InCidr(ip, cidr) {
  const [network, rawPrefix] = String(cidr || '').split('/');
  const addressNumber = ipv4Number(ip);
  const networkNumber = ipv4Number(network);
  const prefix = Number(rawPrefix);
  if (addressNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (networkNumber & mask);
}
