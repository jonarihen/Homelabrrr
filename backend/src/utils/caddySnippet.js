import { Client as SSHClient } from 'ssh2';
import { decryptSecret } from './secrets.js';
import { sshHostFingerprint } from './sshHostKey.js';

// ─── Caddyfile snippet sync ────────────────────────────────────────────────────
// The admin API is ephemeral when Caddy's config comes from a Caddyfile: any
// `caddy reload` / service restart rebuilds the config from the file and drops
// routes Homelabrrr pushed through the API. When SSH is configured on a Caddy
// server, Homelabrrr instead maintains a snippet file on the Caddy host
// (imported once from the main Caddyfile with `import <snippet_path>`),
// regenerates it from the DB on every site change, validates, and reloads —
// so the file on disk is always the source of truth and reloads lose nothing.

const SAFE_PATH_RE = /^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isSafeRemotePath(p) {
  const s = String(p || '');
  return SAFE_PATH_RE.test(s) && !s.includes('..');
}

export function sshConfigured(server) {
  return !!(server && server.ssh_host && server.ssh_user);
}

/**
 * Render every managed site as a plain top-level Caddyfile block. Sites whose
 * domain is covered by a wildcard block in the main Caddyfile need no `tls`
 * directive: the Caddyfile adapter sorts exact hosts above wildcards, and
 * Caddy's automatic HTTPS skips issuance for names covered by a managed
 * wildcard certificate — the wildcard cert serves them.
 * All fields are validated at publish time (domain/upstream regexes, integer
 * port), so nothing here can break out of the block syntax.
 */
export function generateSnippet(sites) {
  const lines = [
    '# Managed by Homelabrrr — DO NOT EDIT.',
    '# Regenerated from the portal on every publish/update/delete.',
    `# ${sites.length} site(s)`,
    '',
  ];
  for (const site of sites) {
    lines.push(`${site.domain} {`);
    lines.push(`\treverse_proxy ${site.upstream_host}:${site.upstream_port}`);
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function connectSsh(server) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const expected = server.ssh_host_key || '';
    let fingerprint = '';
    let hostKeyError = '';
    conn.on('ready', () => resolve({ conn, fingerprint }));
    conn.on('error', (err) => {
      reject(new Error(hostKeyError || `SSH connection to ${server.ssh_host} failed: ${err.message}`));
    });
    const secret = decryptSecret(server.ssh_secret);
    const auth = server.ssh_auth_type === 'password' ? { password: secret } : { privateKey: secret };
    conn.connect({
      host: server.ssh_host,
      port: server.ssh_port || 22,
      username: server.ssh_user,
      readyTimeout: 10000,
      ...auth,
      hostVerifier: (key) => {
        fingerprint = sshHostFingerprint(key);
        if (expected && fingerprint !== expected) {
          hostKeyError = `SSH host key mismatch for ${server.ssh_host}: expected ${expected}, got ${fingerprint}. If the host was rebuilt, re-save the server with a new SSH host to clear the pinned key.`;
          return false;
        }
        return true; // first connect: trust-on-first-use, pinned by the caller
      },
    });
  });
}

function execSsh(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      stream.on('data', (d) => { output += d; });
      stream.stderr.on('data', (d) => { output += d; });
      stream.on('close', (code) => resolve({ code, output }));
    });
  });
}

function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function sftpReadFile(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, data) => {
      if (err) {
        // Missing file is fine — first deploy.
        if (err.code === 2 || /no such file/i.test(err.message || '')) return resolve(null);
        return reject(err);
      }
      resolve(data.toString());
    });
  });
}

function sftpWriteFile(sftp, path, content) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, { mode: 0o644 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Regenerate the snippet on the Caddy host and reload Caddy.
 * Sequence: write to <path>.tmp → mv into place → `caddy validate` → on
 * failure restore the previous snippet and DON'T reload (the running config is
 * never touched by a failed sync) → `caddy reload`.
 * Returns { sites, reloaded, fingerprint } — the caller persists the
 * fingerprint on first use (TOFU pinning).
 */
export async function deploySnippet(server, sites) {
  if (!sshConfigured(server)) throw new Error('SSH is not configured for this Caddy server');
  if (!server.ssh_secret) throw new Error('No SSH credential is stored for this Caddy server');
  const snippetPath = server.snippet_path || '/etc/caddy/homelabrrr.caddy';
  const caddyfilePath = server.caddyfile_path || '/etc/caddy/Caddyfile';
  if (!isSafeRemotePath(snippetPath) || !isSafeRemotePath(caddyfilePath)) {
    throw new Error('Snippet/Caddyfile path must be absolute and contain only letters, digits, and . _ - /');
  }

  const content = generateSnippet(sites);
  const { conn, fingerprint } = await connectSsh(server);
  try {
    const sftp = await getSftp(conn);
    const previous = await sftpReadFile(sftp, snippetPath);
    const tmpPath = `${snippetPath}.tmp`;

    const putInPlace = async (body) => {
      await sftpWriteFile(sftp, tmpPath, body);
      const mv = await execSsh(conn, `mv -f '${tmpPath}' '${snippetPath}'`);
      if (mv.code !== 0) throw new Error(`Could not write the snippet on the Caddy host: ${mv.output.trim()}`);
    };

    await putInPlace(content);

    const validate = await execSsh(conn, `caddy validate --config '${caddyfilePath}' --adapter caddyfile 2>&1`);
    if (validate.code !== 0) {
      // Restore what was there before so the user's next manual reload isn't
      // broken by us. (An empty file keeps a pre-added `import` line working.)
      try { await putInPlace(previous ?? ''); } catch { /* best effort */ }
      throw new Error(`Caddyfile validation failed — snippet rolled back, Caddy was NOT reloaded. ${validate.output.trim().slice(-500)}`);
    }

    const reload = await execSsh(conn, `caddy reload --config '${caddyfilePath}' --adapter caddyfile 2>&1`);
    if (reload.code !== 0) {
      throw new Error(`Caddy reload failed (the snippet is in place; reload manually or re-sync): ${reload.output.trim().slice(-500)}`);
    }

    return { sites: sites.length, reloaded: true, fingerprint };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}
