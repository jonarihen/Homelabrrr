export function decodeNodeRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return { hostId: null, nodeName: '', nodeRef: '' };

  const sepIndex = raw.indexOf('~');
  if (sepIndex > 0) {
    const maybeHostId = raw.slice(0, sepIndex);
    const nodeName = raw.slice(sepIndex + 1);
    if (/^\d+$/.test(maybeHostId) && nodeName) {
      return {
        hostId: Number.parseInt(maybeHostId, 10),
        nodeName,
        nodeRef: raw,
      };
    }
  }

  return { hostId: null, nodeName: raw, nodeRef: raw };
}

export function displayNode(nodeOrRef) {
  return decodeNodeRef(nodeOrRef).nodeName || String(nodeOrRef || '');
}

export function routeNode(vmOrNode) {
  if (!vmOrNode) return '';
  if (typeof vmOrNode === 'string') return decodeNodeRef(vmOrNode).nodeRef || vmOrNode;
  return vmOrNode.nodeRef || vmOrNode.node || '';
}

export function vmIdentityKey(vm) {
  return `${routeNode(vm)}-${vm?.vmid ?? ''}`;
}
