// Regression guard for issue #71: no route may read a legacy `users.can_*`
// column directly, because that ignores role-granted permissions.
// Run with:  node --test src/utils/permissionColumnScan.test.js   (from backend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForLegacyPermissionColumnReads,
  isSanctionedColumnRead,
  unsanctionedColumnReads,
} from './permissionColumnScan.ts';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── the scanner itself ─────────────────────────────────────────────────────

test('flags the exact bug shape from issue #71', () => {
  const src = [
    'function canManageAllPortForwards(req) {',
    "  const user = db.prepare('SELECT can_manage_firewalls FROM users WHERE id = ?').get(req.session.userId);",
    '  return user?.can_manage_firewalls === 1;',
    '}',
  ].join('\n');
  const found = scanForLegacyPermissionColumnReads('src/routes/admin.ts', src);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
  assert.equal(found[0].file, 'src/routes/admin.ts');
});

test('flags other spellings: multiple columns, lowercase sql, aliased table', () => {
  const cases = [
    "db.prepare('SELECT can_manage_vlans, can_manage_policies FROM users WHERE id = ?')",
    "db.prepare('select see_all_vms, can_provision from users where id = ?')",
    "db.prepare('SELECT u.can_manage_users FROM users u WHERE u.id = ?')",
  ];
  for (const line of cases) {
    assert.equal(
      scanForLegacyPermissionColumnReads('src/routes/x.ts', line).length, 1,
      `should flag: ${line}`,
    );
  }
});

test('does not flag unrelated queries or prose about the pattern', () => {
  const src = [
    "  const u = db.prepare('SELECT username, is_admin FROM users WHERE id = ?').get(id);",
    "  db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(roleId);",
    "  db.prepare('SELECT can_manage_firewalls FROM firewall_grants WHERE id = ?').get(id);",
    "  // never write SELECT can_manage_firewalls FROM users WHERE id = ? here",
    '   * SELECT can_manage_firewalls FROM users is banned — use userHasPermission',
  ].join('\n');
  assert.deepEqual(scanForLegacyPermissionColumnReads('src/routes/x.ts', src), []);
});

test('handles empty / missing contents without throwing', () => {
  assert.deepEqual(scanForLegacyPermissionColumnReads('a.ts', ''), []);
  assert.deepEqual(scanForLegacyPermissionColumnReads('a.ts', null), []);
});

// ─── the allowlist ──────────────────────────────────────────────────────────

const PROVISION_LINE = {
  file: 'src/routes/provision.ts',
  line: 134,
  text: "  const user = db.prepare('SELECT id, can_provision, is_admin, role_id FROM users WHERE id = ?').get(req.session.userId);",
};

test('the provision.js read is sanctioned', () => {
  assert.equal(isSanctionedColumnRead(PROVISION_LINE), true);
  assert.deepEqual(unsanctionedColumnReads([PROVISION_LINE]), []);
});

test('the same query in any other file is NOT sanctioned', () => {
  const copied = { ...PROVISION_LINE, file: 'src/routes/admin.ts' };
  assert.equal(isSanctionedColumnRead(copied), false);
  assert.equal(unsanctionedColumnReads([copied]).length, 1);
});

test('provision.js loses its exemption if it stops selecting role_id', () => {
  const withoutRole = {
    ...PROVISION_LINE,
    text: "  const user = db.prepare('SELECT id, can_provision FROM users WHERE id = ?').get(req.session.userId);",
  };
  assert.equal(isSanctionedColumnRead(withoutRole), false);
});

// ─── the real source tree ───────────────────────────────────────────────────

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      // Test files are skipped: they hold example SQL, not authorization code.
      out.push(full);
    }
  }
  return out;
}

function scanBackendSource() {
  const findings = [];
  for (const file of walkJsFiles(SRC_ROOT)) {
    const rel = path.relative(path.join(SRC_ROOT, '..'), file);
    findings.push(...scanForLegacyPermissionColumnReads(rel, fs.readFileSync(file, 'utf8')));
  }
  return findings;
}

test('backend/src reads no legacy permission column outside the allowlist', () => {
  const offenders = unsanctionedColumnReads(scanBackendSource());
  assert.deepEqual(
    offenders, [],
    'These lines read a users.can_* column directly, which ignores role-granted\n'
    + 'permissions. Use userHasPermission()/effectivePermissions() from\n'
    + `utils/permissions.js instead:\n${offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}`,
  );
});

test('no legacy raw permission-column SQL reads remain after the Drizzle migration', () => {
  // The scanner matches raw better-sqlite3 `SELECT can_* FROM users` text. The
  // PostgreSQL migration replaced every such read with a Drizzle select, so the
  // live tree now contains zero — including the formerly-sanctioned provision.ts
  // read, which still folds the role back in (see the next test). The scanner and
  // its allowlist mechanics stay as a regression guard against anyone
  // reintroducing raw permission-column SQL.
  const findings = scanBackendSource();
  assert.deepEqual(unsanctionedColumnReads(findings), []);
  assert.equal(findings.length, 0);
});

test('the sanctioned provision.js read really does fold the role back in', () => {
  const src = fs.readFileSync(path.join(SRC_ROOT, 'routes', 'provision.ts'), 'utf8');
  // The optional `)` tolerates the async form: (await getRolePermissions(...)).has(...)
  assert.match(src, /getRolePermissions\(user\.role_id\)\)?\.has\('can_provision'\)/);
});
