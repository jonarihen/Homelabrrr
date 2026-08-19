// Which websocket close codes may actually be put on the wire.
//
// RFC 6455 reserves 1005 ("no status received") and 1006 ("abnormal closure")
// as codes a peer *reports* locally when the connection ends without a proper
// close frame — they must never be sent. `ws` enforces this by throwing from
// Sender.close, so relaying an upstream code straight through crashes the
// process when a Proxmox console drops instead of closing cleanly.
//
// Sendable: 1000-1014 except 1004/1005/1006, plus the private 3000-4999 range.
export function sendableCloseCode(code) {
  const n = Number(code);
  if (!Number.isInteger(n)) return null;
  if (n >= 3000 && n <= 4999) return n;
  if (n >= 1000 && n <= 1014 && n !== 1004 && n !== 1005 && n !== 1006) return n;
  return null;
}
