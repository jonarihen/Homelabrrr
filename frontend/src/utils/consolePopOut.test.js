import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleSessionUrl } from './consolePopOut.js';

const vm = { node: 'pve', nodeRef: '2~pve', vmid: 101, name: 'Lab console & tools / #1' };

for (const type of ['vnc', 'ssh']) {
  test(`${type} pop-out preserves the cluster node reference and encodes the VM name`, () => {
    assert.equal(consoleSessionUrl({ type, vm }), `/${type}/2~pve/101?name=Lab%20console%20%26%20tools%20%2F%20%231`);
  });

  test(`${type} pop-out omits the query string for an unnamed VM`, () => {
    assert.equal(consoleSessionUrl({ type, vm: { ...vm, name: '' } }), `/${type}/2~pve/101`);
    assert.equal(consoleSessionUrl({ type, vm: { node: '2~pve', vmid: 101 } }), `/${type}/2~pve/101`);
  });

  test(`${type} pop-out supports legacy bare node names`, () => {
    assert.equal(consoleSessionUrl({ type, vm: { node: 'pve', vmid: 101 } }), `/${type}/pve/101`);
  });
}
