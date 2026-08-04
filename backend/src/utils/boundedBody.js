export function collectBoundedBody(stream, { maxBytes = 4096 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    stream.on('data', (chunk) => {
      if (bytes >= maxBytes) return;
      const buffer = Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(buffer.length, remaining);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
