import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAddress, isProhibitedManagementAddress } from './urlGuard.ts';

test('address classification covers IPv4 special ranges', () => {
  const cases: [string, string][] = [
    ['0.0.0.0', 'unspecified'], ['127.0.0.1', 'loopback'], ['127.255.0.9', 'loopback'],
    ['169.254.169.254', 'metadata'], ['169.254.10.1', 'link_local'], ['100.100.100.200', 'metadata'],
    ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['192.168.40.10', 'private'], ['100.64.0.1', 'shared'],
    ['198.18.0.1', 'benchmark'], ['224.0.0.1', 'multicast'], ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'], ['255.255.255.255', 'reserved'], ['8.8.8.8', 'public'], ['not-an-ip', 'invalid'],
  ];
  for (const [address, expected] of cases) assert.equal(classifyAddress(address), expected, address);
});

test('IPv6 forms that embed IPv4 are classified by the embedded address', () => {
  const cases: [string, string][] = [
    ['::', 'unspecified'], ['::1', 'loopback'], ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::FFFF:7F00:0001', 'loopback'],
    ['::ffff:a9fe:a9fe', 'metadata'], ['::ffff:169.254.169.254', 'metadata'], ['::ffff:c0a8:2801', 'private'],
    ['::127.0.0.1', 'loopback'], ['64:ff9b::7f00:1', 'loopback'], ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['2002:7f00:1::', 'loopback'], ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link_local'], ['fe80::1%eth0', 'link_local'], ['febf::1', 'link_local'],
    ['ff02::1', 'multicast'], ['ff05::1:3', 'multicast'], ['fd12:3456::10', 'private'], ['fc00::1', 'private'],
    ['2001:db8::1', 'public'], ['2a00:1450:4001::200e', 'public'],
  ];
  for (const [address, expected] of cases) assert.equal(classifyAddress(address), expected, address);
});

test('management guard keeps private networks and blocks probe targets', () => {
  for (const ok of ['10.0.0.5', '192.168.40.10', '172.20.1.1', '100.64.3.4', 'fd12::5', '::ffff:10.0.0.5']) {
    assert.equal(isProhibitedManagementAddress(ok), false, ok);
  }
  for (const bad of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.251', '255.255.255.255', '::1', '::ffff:7f00:1',
    'fe80::1', 'ff02::1', '64:ff9b::7f00:1', 'fd00:ec2::254', 'garbage']) {
    assert.equal(isProhibitedManagementAddress(bad), true, bad);
  }
});

test('public download guard still refuses literal internal and embedded addresses', async () => {
  const { assertPublicDownloadUrl } = await import('./urlGuard.ts');
  delete process.env.ALLOW_INTERNAL_IMAGE_URLS;
  for (const url of ['http://127.0.0.1/a.iso', 'http://[::ffff:127.0.0.1]/a.iso', 'http://[::ffff:a00:1]/a.iso', 'http://[ff02::1]/x', 'http://192.168.1.2/x', 'http://169.254.169.254/latest']) {
    await assert.rejects(assertPublicDownloadUrl(url), /internal\/reserved/, url);
  }
  await assertPublicDownloadUrl('http://8.8.8.8/a.iso');
});
