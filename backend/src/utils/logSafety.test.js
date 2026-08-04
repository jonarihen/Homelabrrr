import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function javascriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(path));
    else if (['.js', '.jsx'].includes(extname(entry.name)) && !entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

test('source does not log credential fragments or raw auth headers', () => {
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const path of javascriptFiles(sourceRoot)) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:ticket|token)[^\n]*\.slice\s*\(/i, path);
    assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*headers\[['"](?:authorization|cookie)['"]\]/i, path);
    assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*\$\{username\}@\$\{host\}/i, path);
  }
});
