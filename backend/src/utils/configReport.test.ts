// Regression coverage for the recognised-environment table and its startup report.
// The last two tests are the ones that stop issue #79 from recurring: they tie the
// declared table to docker-compose.yml and to what the source actually reads.
// Run with:  node --test src/utils/configReport.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPTIONAL_ENV_VARS,
  REQUIRED_ENV_VARS,
  buildConfigReport,
  formatConfigReport,
} from './configReport.ts';

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// A full env with every optional variable set to something other than its default.
const allSet = Object.fromEntries(
  OPTIONAL_ENV_VARS.map((v) => [v.name, `custom-${v.name.toLowerCase()}`]),
);

// ─── buildConfigReport ────────────────────────────────────────────────────────

test('every optional variable is set: all reported as set, none unset', () => {
  const report = buildConfigReport(allSet);
  assert.equal(report.set.length, OPTIONAL_ENV_VARS.length);
  assert.deepEqual(report.unset, []);
  assert.deepEqual(report.defaulted, []);
  assert.ok(report.entries.every((e) => e.status === 'set'));
});

test('nothing is set: every optional variable is reported as unset', () => {
  const report = buildConfigReport({});
  assert.deepEqual(report.set, []);
  assert.deepEqual(report.defaulted, []);
  assert.deepEqual(report.unset, OPTIONAL_ENV_VARS.map((v) => v.name));
  // Unset entries carry no value and always explain what happens instead.
  for (const entry of report.entries) {
    assert.equal(entry.value, null);
    assert.ok(entry.unsetNote.length > 0, `${entry.name} needs an unset note`);
  }
});

test('buildConfigReport() with no argument behaves like an empty environment', () => {
  assert.deepEqual(buildConfigReport().unset, OPTIONAL_ENV_VARS.map((v) => v.name));
});

test('partially set: only the provided variables are reported as set', () => {
  const report = buildConfigReport({
    PORTAL_BASE_URL: 'https://portal.example.com',
    NODE_HEALTH_POLL_MS: '0',
  });
  assert.deepEqual(report.set, ['PORTAL_BASE_URL', 'NODE_HEALTH_POLL_MS']);
  assert.ok(report.unset.includes('LEASE_CHECK_INTERVAL_MS'));
  assert.ok(report.unset.includes('VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS'));
  assert.equal(report.unset.length, OPTIONAL_ENV_VARS.length - 2);

  const portal = report.entries.find((e) => e.name === 'PORTAL_BASE_URL');
  assert.equal(portal.value, 'https://portal.example.com');
});

test('empty string counts as unset — this is the docker-compose "${FOO:-}" case', () => {
  // `- PORTAL_BASE_URL=${PORTAL_BASE_URL:-}` with no .env entry reaches the
  // container as an empty string, not as an absent variable.
  const report = buildConfigReport({
    PORTAL_BASE_URL: '',
    ALLOWED_ORIGIN: '   ',
    INITIAL_ADMIN_PASSWORD: '',
    NODE_HEALTH_POLL_MS: '30000',
  });
  assert.ok(report.unset.includes('PORTAL_BASE_URL'));
  assert.ok(report.unset.includes('ALLOWED_ORIGIN'));
  assert.ok(report.unset.includes('INITIAL_ADMIN_PASSWORD'));
  assert.deepEqual(report.set, ['NODE_HEALTH_POLL_MS']);
});

test('a value equal to the documented default is reported as defaulted, not set', () => {
  const report = buildConfigReport({
    NODE_HEALTH_POLL_MS: '60000',
    LEASE_CHECK_INTERVAL_MS: '900000',
    VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS: '300000',
  });
  assert.deepEqual(report.defaulted, ['NODE_HEALTH_POLL_MS', 'LEASE_CHECK_INTERVAL_MS']);
  assert.deepEqual(report.set, ['VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS']);
  // A variable with no value-shaped default can never be "defaulted".
  assert.equal(
    buildConfigReport({ PORTAL_BASE_URL: 'x' }).entries
      .find((e) => e.name === 'PORTAL_BASE_URL').status,
    'set',
  );
});

test('formatConfigReport never prints a secret value', () => {
  const lines = formatConfigReport(buildConfigReport({
    ...allSet,
    INITIAL_ADMIN_PASSWORD: 'hunter2',
    SESSION_SECRET: 'also-secret',
  })).join('\n');
  assert.ok(!lines.includes('hunter2'));
  assert.ok(!lines.includes('also-secret'));
  assert.match(lines, /INITIAL_ADMIN_PASSWORD\s+= <set>/);
});

test('formatConfigReport explains each unset variable on its own line', () => {
  const lines = formatConfigReport(buildConfigReport({}));
  // One summary line plus one line per variable.
  assert.equal(lines.length, OPTIONAL_ENV_VARS.length + 1);
  const joined = lines.join('\n');
  for (const spec of OPTIONAL_ENV_VARS) {
    assert.match(joined, new RegExp(`${spec.name}\\s+ not set`));
  }
  assert.match(joined, /falls back to ALLOWED_ORIGIN/);
});

// ─── The declared table vs. docker-compose.yml ───────────────────────────────

// Minimal reader for the backend service's `environment:` list. Deliberately not
// a general YAML parser: it only has to see the shape this repo's compose file
// actually uses (`      - KEY=value`).
function backendEnvKeys(composeText) {
  const lines = composeText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}backend:\s*$/.test(l));
  assert.ok(start >= 0, 'docker-compose.yml has no "backend:" service');

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i].length - lines[i].trimStart().length <= 2) { end = i; break; }
  }
  const block = lines.slice(start + 1, end);

  const envStart = block.findIndex((l) => /^ {4}environment:\s*$/.test(l));
  assert.ok(envStart >= 0, 'backend service has no "environment:" block');

  const keys = [];
  for (let i = envStart + 1; i < block.length; i++) {
    const line = block[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (line.length - line.trimStart().length <= 4) break;   // next key of the service
    const match = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

test('backendEnvKeys reads a compose environment block', () => {
  const sample = [
    'services:',
    '  backend:',
    '    environment:',
    '      # a comment',
    '      - NODE_ENV=production',
    '      - PORTAL_BASE_URL=${PORTAL_BASE_URL:-}',
    '    volumes:',
    '      - db_data:/app/data',
    '  frontend:',
    '    environment:',
    '      - NOT_THE_BACKEND=1',
  ].join('\n');
  assert.deepEqual(backendEnvKeys(sample), ['NODE_ENV', 'PORTAL_BASE_URL']);
});

test('docker-compose.yml passes every variable the backend recognises', () => {
  const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const passed = new Set(backendEnvKeys(compose));

  for (const name of [...REQUIRED_ENV_VARS, ...OPTIONAL_ENV_VARS.map((v) => v.name)]) {
    assert.ok(
      passed.has(name),
      `${name} is recognised by the backend but the backend service in `
      + 'docker-compose.yml never passes it — setting it in .env would do nothing',
    );
  }
});

// ─── The declared table vs. what the source actually reads ───────────────────

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// Comments are scanned too — this fails closed on purpose. A prose mention of a
// variable name is far cheaper to reword than a missed real read is to debug.
test('every process.env read in src/ is declared in configReport.ts', () => {
  const recognised = new Set([...REQUIRED_ENV_VARS, ...OPTIONAL_ENV_VARS.map((v) => v.name)]);
  const found = new Map();   // name -> first file that reads it

  for (const file of jsFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!found.has(match[1])) found.set(match[1], file.slice(SRC_DIR.length));
    }
  }

  assert.ok(found.size > 0, 'scanner found no process.env reads at all');
  for (const [name, file] of found) {
    assert.ok(
      recognised.has(name),
      `${file} reads process.env.${name} but it is not declared in configReport.js, `
      + 'so nothing checks that docker-compose.yml passes it',
    );
  }
});
