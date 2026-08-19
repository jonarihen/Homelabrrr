const NODE_REF_SEPARATOR = '~';

// Proxmox node names are DNS-label shaped. Anything outside this set ('/',
// '?', '#', whitespace, …) could steer the upstream API request path when the
// name is interpolated into a URL, so it must be rejected before any request.
// Dot-only names ('.', '..') match the pattern but normalize as traversal.
const NODE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function isValidNodeName(nodeName) {
  const name = String(nodeName || '');
  return NODE_NAME_PATTERN.test(name) && !/^\.+$/.test(name);
}

export function encodeNodeRef(hostId, nodeName) {
  const node = String(nodeName || '').trim();
  if (!node) return '';
  const parsedHostId = Number.parseInt(hostId, 10);
  if (!Number.isInteger(parsedHostId) || parsedHostId <= 0) return node;
  return `${parsedHostId}${NODE_REF_SEPARATOR}${node}`;
}

export function decodeNodeRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return { hostId: null, nodeName: '', nodeRef: '' };

  const sepIndex = raw.indexOf(NODE_REF_SEPARATOR);
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

export function nodeLookupCandidates(value) {
  const { hostId, nodeName, nodeRef } = decodeNodeRef(value);
  if (!hostId || nodeRef === nodeName) return [nodeName].filter(Boolean);
  return [nodeRef, nodeName].filter(Boolean);
}
