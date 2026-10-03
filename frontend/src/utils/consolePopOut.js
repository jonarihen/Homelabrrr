import { routeNode } from './nodeRef.js';

export function consoleSessionUrl(session) {
  const nodeRef = routeNode(session.vm);
  const path = session.type === 'vnc'
    ? `/vnc/${nodeRef}/${session.vm.vmid}`
    : `/ssh/${nodeRef}/${session.vm.vmid}`;
  const name = session.vm.name;
  return name ? `${path}?name=${encodeURIComponent(name)}` : path;
}
