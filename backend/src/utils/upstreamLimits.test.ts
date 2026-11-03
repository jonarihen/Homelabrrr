// Run with:  node --test src/utils/upstreamLimits.test.ts   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { limitUpstreamRequest, capUpstreamBody } from './upstreamLimits.ts';

// A server that writes `chunks` pieces of `size` bytes, `gapMs` apart, then ends.
async function dripServer(t, { chunks, size, gapMs }) {
  const server = http.createServer(async (_req, res) => {
    for (let i = 0; i < chunks && !res.destroyed; i++) {
      res.write(Buffer.alloc(size, 'x'));
      await new Promise((r) => setTimeout(r, gapMs));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (server.address() as any).port;
}

function fetchWithLimits(port, { deadlineMs, maxBytes }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/' }, (res) => {
      const parts: Buffer[] = [];
      capUpstreamBody(req, res, 'Test', (c) => parts.push(c), maxBytes);
      res.on('end', () => resolve(Buffer.concat(parts).toString()));
    });
    req.on('error', reject);
    // Idle timeout alone would never fire: the server sends something every gap.
    req.setTimeout(1000, () => req.destroy(new Error('idle timeout')));
    limitUpstreamRequest(req, 'Test', { deadlineMs });
    req.end();
  });
}

test('a slow-drip response fails at the total deadline, not the idle timeout', async (t) => {
  const port = await dripServer(t, { chunks: 50, size: 10, gapMs: 50 });
  await assert.rejects(fetchWithLimits(port, { deadlineMs: 300, maxBytes: 1e6 }), /exceeded the 0s deadline|deadline/);
});

test('an oversized body fails the request instead of being truncated', async (t) => {
  const port = await dripServer(t, { chunks: 5, size: 1000, gapMs: 1 });
  await assert.rejects(fetchWithLimits(port, { deadlineMs: 5000, maxBytes: 2500 }), /exceeded 2500 bytes/);
});

test('a normal response inside both limits resolves with the full body', async (t) => {
  const port = await dripServer(t, { chunks: 3, size: 4, gapMs: 1 });
  assert.equal(await fetchWithLimits(port, { deadlineMs: 5000, maxBytes: 1e6 }), 'x'.repeat(12));
});
