// Buffered upstream API calls (Proxmox, FortiGate) only had a socket idle
// timeout, so a slow-drip response could run indefinitely and grow without
// bound. These add a total deadline and a body-size cap; both fail the request
// through its normal 'error' path.
export const UPSTREAM_DEADLINE_MS = 60_000;
export const UPSTREAM_MAX_BODY_BYTES = 32 * 1024 * 1024;

export function limitUpstreamRequest(req, label: string, { deadlineMs = UPSTREAM_DEADLINE_MS } = {}) {
  const timer = setTimeout(() => {
    req.destroy(new Error(`${label} request exceeded the ${Math.round(deadlineMs / 1000)}s deadline`));
  }, deadlineMs);
  timer.unref?.();
  req.once('close', () => clearTimeout(timer));
}

// Hands each chunk to onChunk until the body passes maxBytes, then fails the request.
export function capUpstreamBody(req, res, label: string, onChunk: (chunk: Buffer) => void, maxBytes = UPSTREAM_MAX_BODY_BYTES) {
  let bytes = 0;
  res.on('data', (chunk) => {
    if (req.destroyed) return;
    bytes += chunk.length;
    if (bytes > maxBytes) {
      req.destroy(new Error(`${label} response exceeded ${maxBytes} bytes`));
      return;
    }
    onChunk(chunk);
  });
}
