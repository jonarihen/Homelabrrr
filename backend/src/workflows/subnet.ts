import { vlanTagToSubnet } from '../fortigate.ts';

/**
 * Subnet derivation for a VLAN tag. This used to be the hardcoded
 * `10.<x>.<y>.0/24` formula in fortigate.js; it is now a workflow-level setting
 * so deployments with a different addressing scheme don't need a code change.
 *
 * The only configurable knob today is the leading octet (`settings.subnet.firstOctet`).
 * When it is absent or equal to the historical default (10), the result is
 * byte-for-byte identical to `vlanTagToSubnet` — preserving current behavior.
 *
 * settings shape: { subnet: { firstOctet: 10 } }
 */
export function deriveSubnet(tag, settings) {
  const firstOctet = Number(settings?.subnet?.firstOctet);
  if (!Number.isInteger(firstOctet) || firstOctet < 0 || firstOctet > 255 || firstOctet === 10) {
    // Default formula (or an out-of-range value) → the original derivation.
    return vlanTagToSubnet(tag);
  }

  const s = String(tag).padStart(4, '0');
  if (s.length !== 4) return null;
  const oct2 = parseInt(s.substring(0, 2), 10);
  const oct3 = parseInt(s.substring(2, 4), 10);
  if (oct2 > 255 || oct3 > 255) return null;
  const base = `${firstOctet}.${oct2}.${oct3}`;
  return {
    ip: `${base}.1`,
    netmask: '255.255.255.0',
    network: `${base}.0/24`,
    networkIp: `${base}.0`,
    dhcpStart: `${base}.10`,
    dhcpEnd: `${base}.254`,
    gateway: `${base}.1`,
  };
}
