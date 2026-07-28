// Shared connection-state vocabulary for the VNC and SSH console panels.
//
// Both consoles ride a single-use, short-lived upstream token (see the
// vncSessions/sshSessions maps in the backend), so a dropped connection can
// never be resumed — it can only be replaced by minting a fresh token and
// reconnecting. The panels use `canReconnect` to decide when to offer that.

export const CONNECTING = 'Connecting...';
export const CONNECTED = 'Connected';
export const DISCONNECTED = 'Disconnected';
export const CONNECTION_LOST = 'Connection lost';
export const CONNECTION_ERROR = 'Error';

// Dead states: the socket has settled and is not coming back on its own.
const RECONNECTABLE = new Set([DISCONNECTED, CONNECTION_LOST, CONNECTION_ERROR]);

export function isConnected(status) {
  return status === CONNECTED;
}

/**
 * True when a fresh connection attempt makes sense.
 *
 * Deliberately false while connecting, so the user can't stack ticket requests
 * against a Proxmox proxy that only tolerates one, and false once connected so
 * the button stays out of the way.
 */
export function canReconnect(status) {
  return typeof status === 'string' && RECONNECTABLE.has(status);
}
