# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Homelabrrr is a self-service portal that puts a guardrail layer between users and raw Proxmox/FortiGate access. A React SPA (frontend) talks to an Express API (backend) that proxies to one or more Proxmox VE clusters and FortiGate firewalls. State lives in SQLite. Two Docker containers: `backend` (Node) and `frontend` (Vite build served by nginx, which also reverse-proxies `/api/*` and websocket upgrades to the backend).

## Commands

There is no test suite, linter, or CI config in this repo. Development is done by running the two processes and exercising the UI.

**Local dev (PowerShell — this is a Windows repo):**
```powershell
# Backend — needs env vars set in the shell before starting
cd backend
npm install
New-Item -ItemType Directory -Force data
$env:SESSION_SECRET="dev-session-secret"
$env:SECRET_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"   # exactly 32 bytes
$env:INITIAL_ADMIN_USERNAME="admin"
$env:INITIAL_ADMIN_PASSWORD="change-this-before-first-start"
$env:DB_PATH="./data/db.sqlite"
node src/index.js            # backend on :3000

# Frontend — separate shell
cd frontend
npm install
npm run dev                  # Vite on :5173, proxies /api + ws to :3000
```

**Production build:** `docker compose up -d --build` (needs a populated `.env`; frontend published on host `:8181`). Frontend build alone: `cd frontend && npm run build`.

Backend has **no `dev`/`start` script** — run it with `node src/index.js`. It requires `SESSION_SECRET` and `SECRET_ENCRYPTION_KEY` or it throws on startup. On an empty DB it also requires `INITIAL_ADMIN_USERNAME`/`INITIAL_ADMIN_PASSWORD` to bootstrap the first admin.

## Backend architecture

- **ESM everywhere** (`"type": "module"`). Node 20.
- **`src/index.js`** is the entrypoint: wires Express routes, mounts the session middleware, and hosts the two **raw WebSocket proxies** (`/api/vnc` → Proxmox noVNC websocket, `/api/ssh` → `ssh2` shell). WS upgrades are authenticated by (a) origin check, (b) replaying the session cookie through the session middleware manually, and (c) a **single-use short-lived token** minted by the REST route and stored in an in-memory `Map` (`vncSessions`/`sshSessions`, exported from the route files). Tokens are marked `_consumed` on upgrade to block replay. On startup it also migrates any stored PuTTY `.ppk` SSH keys to OpenSSH format via the `puttygen` binary (installed in the backend Docker image).
- **`src/db.js`** owns the SQLite schema. **Schema evolution is done inline** with `CREATE TABLE IF NOT EXISTS` plus a long list of `try { ALTER TABLE ... } catch {}` migration statements — when adding a column, follow that same pattern rather than introducing a migration framework. Also runs a one-time secret-encryption migration and the first-run admin bootstrap. `better-sqlite3` is **synchronous** — DB calls are not awaited.
- **`src/proxmox.js`** — multi-host Proxmox client. Every request resolves which registered `pve_hosts` row to use. Auth is a PVE API token (`PVEAPIToken=...`). TLS verification is per-host (`verify_tls`); `assertSecureTls` refuses insecure hosts unless `ALLOW_INSECURE_UPSTREAM_TLS=true`.
- **`src/fortigate.js`** — FortiGate REST client (VLANs, policies, VIPs/port-forwards, DHCP, switch discovery).
- **`src/routes/*`** — one router per domain (`auth`, `admin`, `vms`, `ssh`, `sftp`, `provision`, `cloudimages`). Routers apply `requireAuth` at the top and gate individual handlers.
- **`src/utils/`** — cross-cutting helpers. Notably `secrets.js` (AES encryption at rest, `enc:v1:` prefix), `audit.js` (`logAudit`), `capacity.js` (pre-flight node memory/storage checks), `cpuTopology.js`, `vmTags.js` (stamps owner/VLAN as PVE tags), `sshHostKey.js` (host-key fingerprint verification), `sanitize.js` (`sanitizeError` scrubs leaked details before returning 500s).

### node references — important
A "node" identifier in this codebase is **not** a bare Proxmox node name. Because VMIDs are globally unique across multiple clusters, nodes are encoded as `"<hostId>~<nodeName>"` (see `utils/nodeRef.js`, present in **both** backend and frontend). Always round-trip node values through `decodeNodeRef` / `encodeNodeRef` / `nodeLookupCandidates` rather than string-splitting by hand. DB lookups that match on `node` must try all `nodeLookupCandidates` (legacy rows may store the bare name).

### authorization model
Two layers, both admin-bypassed:
- **Route middleware** (`middleware/auth.js`): `requireAuth`, `requireAdmin`, and `requirePermission('can_manage_x', ...)` which passes if the user is admin OR any listed `can_*` column is `1`. The granular permission columns live on the `users` table (added via the ALTER migrations).
- **VM-level access** (`utils/vmOps.js` + `utils/vmAccess.js`): every VM route calls `userCanPerformVmOp(userId, node, vmid, isAdmin, op)` with an op key from the `VM_OP_TIERS` table in `utils/vmOps.js` (pure, unit-tested in `vmOps.test.js`). Three tiers: `read` (assignment OR `see_all_vms` OR `can_operate_all_vms`), `operate` (assignment OR `can_operate_all_vms` — power, console/SSH/SFTP, snapshots, backups, VLAN/hardware, DHCP), and `own` (strict assignment only — delete, restore, snapshot rollback, cloud-init creds, lease renewal, schedule edits). Add a new route by adding its op to the table, not by hand-rolling a check. `userCanAccessVm`/`userOwnsVm` remain for non-route callers.

### security-sensitive behaviors (preserve these)
Session cookies are httpOnly/sameSite=lax/secure. TOTP 2FA with a `twoFactorEnrollmentOnly` session state that locks the user out of everything except 2FA setup. Login and 2FA attempts are rate-limited via the `login_attempts`/`two_factor_attempts` tables. All upstream secrets (PVE token secrets, FortiGate API keys, SSH private keys, TOTP secrets) are **encrypted at rest** — never store them plaintext; use `encryptSecret`/`decryptSecret`. WS upgrades verify origin against `ALLOWED_ORIGIN`.

## Frontend architecture

- **React 18 + Vite 5 + Tailwind 3 + React Router 6.** Plain JS/JSX, no TypeScript.
- **`src/api.js`** — the single axios instance (`baseURL: '/api'`, `withCredentials`). A response interceptor redirects to `/login` on 401. Import this everywhere; don't call axios directly.
- **Two contexts** wrap the app (`App.jsx`): `AuthContext` (current user + `permissions` map + loading) and `ConsoleSessionsContext` (the global multi-session VNC/SSH **console dock** — sessions that minimize/restore/tile/pop-out). Route guards `PrivateRoute`/`AdminRoute`/`AdminIndexRedirect` read from `AuthContext`; the 2FA-enrollment gate forces users to `/account`.
- **Console access** uses `@novnc/novnc` (VNC over the backend ws proxy) and `@xterm/xterm` (SSH). VNC has a clipboard "Paste" that types the clipboard into the guest as keystrokes (`utils/vncPaste.js`) — no guest agent needed.
- **Pages** split into user pages (`src/pages/*`) and admin pages (`src/pages/admin/*` under `AdminLayout`). Standalone routes exist for popped-out consoles (`/vnc/:node/:vmid`, `/ssh/:node/:vmid`).
- **Changelog**: the sidebar changelog panel imports the repo-root `CHANGELOG.md` directly via Vite's `?raw` (`import ... from '../../../CHANGELOG.md?raw'`) and parses it client-side (`utils/changelog.js`). The frontend Dockerfile copies `CHANGELOG.md` into the build context. When you ship a user-visible change, add a dated `## YYYY-MM-DD — Title` entry to `CHANGELOG.md`.

## Design language

`aaris-design-language.md` + `aaris.css` define the intended visual language: dark, technical, "operator console / datacenter / homelab" feel — not generic SaaS. Match it when building UI.

## Conventions

- Match existing style: ESM, synchronous `better-sqlite3` calls, one router per domain, one axios instance, node values always encoded/decoded via `nodeRef`.
- Add DB columns/tables through the inline `IF NOT EXISTS` / `try…catch ALTER` pattern in `db.js` — there is no separate migrations directory.
- Return errors through `sanitizeError` on 500 paths; log meaningful admin actions with `logAudit`.
- This is a Windows development environment; prefer PowerShell syntax for local commands.
