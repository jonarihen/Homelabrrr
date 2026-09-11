import { connectTofuSsh, execTofuSsh } from './sshTofu.ts';

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

const HOST_KEY_HINT = 'If the host was rebuilt, re-save the server with a new SSH host to clear the pinned key.';

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
  const { conn, fingerprint } = await connectTofuSsh(server, HOST_KEY_HINT);
  try {
    const sftp = await getSftp(conn);
    const previous = await sftpReadFile(sftp, snippetPath);
    const tmpPath = `${snippetPath}.tmp`;

    const putInPlace = async (body) => {
      await sftpWriteFile(sftp, tmpPath, body);
      const mv = await execTofuSsh(conn, `mv -f '${tmpPath}' '${snippetPath}'`);
      if (mv.code !== 0) throw new Error(`Could not write the snippet on the Caddy host: ${mv.output.trim()}`);
    };

    await putInPlace(content);

    const validate = await execTofuSsh(conn, `caddy validate --config '${caddyfilePath}' --adapter caddyfile 2>&1`);
    if (validate.code !== 0) {
      // Restore what was there before so the user's next manual reload isn't
      // broken by us. (An empty file keeps a pre-added `import` line working.)
      try { await putInPlace(previous ?? ''); } catch { /* best effort */ }
      throw new Error(`Caddyfile validation failed — snippet rolled back, Caddy was NOT reloaded. ${validate.output.trim().slice(-500)}`);
    }

    const reload = await execTofuSsh(conn, `caddy reload --config '${caddyfilePath}' --adapter caddyfile 2>&1`);
    if (reload.code !== 0) {
      throw new Error(`Caddy reload failed (the snippet is in place; reload manually or re-sync): ${reload.output.trim().slice(-500)}`);
    }

    return { sites: sites.length, reloaded: true, fingerprint };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}
