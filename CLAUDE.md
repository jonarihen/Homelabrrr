# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Homelabrrr is a self-service portal that puts a guardrail layer between users and raw Proxmox/FortiGate access. A React SPA (frontend) talks to an Express API (backend) that proxies to one or more Proxmox VE clusters and FortiGate firewalls. State lives in **PostgreSQL**, accessed through **Drizzle ORM** over **node-postgres (`pg`)** with a shared connection pool. Three Docker services: `postgres` (`postgres:17-alpine`), `backend` (Node/TypeScript), and `frontend` (Vite build served by nginx, which also reverse-proxies `/api/*` and websocket upgrades to the backend).

## Commands

The backend has a full test/lint/type-check surface (~620 tests via `node --test`, `eslint`, and a strict type-check of the db layer), and GitHub Actions (`.github/workflows/ci.yml`) runs CI on every PR — see the README's "Tests and Build Checks". Day-to-day development is still done by running the two processes and exercising the UI.

Backend npm scripts: `npm start` (`node src/index.ts`), `npm run dev` (`node --watch src/index.ts`), `npm test` (`node --test`), `npm run lint` (`eslint src`), `npm run typecheck` (strict `tsc --noEmit` of the db layer), `npm run db:generate` (drizzle-kit), `npm run import-sqlite`, `npm run restore-backup`. The backend is **TypeScript run directly** — Node's native type stripping means there is no build step; `.ts` files are executed as-is.

The backend needs a reachable **PostgreSQL** and a `DATABASE_URL`. A throwaway local database:

```bash
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine
```

**Local dev (PowerShell — env vars in the shell before starting):**
```powershell
# Backend — needs env vars set in the shell before starting
cd backend
npm install
$env:DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/postgres"
$env:SESSION_SECRET="dev-session-secret"
$env:SECRET_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"   # exactly 32 bytes
$env:INITIAL_ADMIN_USERNAME="admin"
$env:INITIAL_ADMIN_PASSWORD="change-this-before-first-start"
npm run dev                  # backend on :3000 (node --watch src/index.ts)

# Frontend — separate shell
cd frontend
npm install
npm run dev                  # Vite on :5173, proxies /api + ws to :3000
```

The backend requires `DATABASE_URL`, `SESSION_SECRET`, and `SECRET_ENCRYPTION_KEY` or it throws on startup. On an empty DB it also requires `INITIAL_ADMIN_USERNAME`/`INITIAL_ADMIN_PASSWORD` to bootstrap the first admin. The test suite reads `TEST_DATABASE_URL` (defaults to `postgres://postgres:postgres@127.0.0.1:5432/postgres`) and also needs a reachable PostgreSQL.

**Production build:** `docker compose up -d --build` (needs a populated `.env`; frontend published on host `:8181`). It starts the `postgres` service and the backend waits for it to be healthy before migrating. Frontend build alone: `cd frontend && npm run build`.

## Backend architecture

- **ESM + TypeScript everywhere** (`"type": "module"`). Node 26 (`engines: >=26.0.0 <27`), run via native type stripping — no build step. Files are `.ts` and import specifiers carry the explicit `.ts` extension (e.g. `import { db } from './db/client.ts'`). Keep to erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- **`src/index.ts`** is the entrypoint: `await initDatabase()` runs first (before any middleware is wired), then it wires Express routes, mounts the session middleware, and hosts the two **raw WebSocket proxies** (`/api/vnc` → Proxmox noVNC websocket, `/api/ssh` → `ssh2` shell). WS upgrades are authenticated by (a) origin check, (b) replaying the session cookie through the session middleware manually, and (c) a **single-use short-lived token** minted by the REST route and stored in an in-memory `Map` (`vncSessions`/`sshSessions`, exported from the route files). Tokens are marked `_consumed` on upgrade to block replay. On startup it also migrates any stored PuTTY `.ppk` SSH keys to OpenSSH format via the `puttygen` binary (installed in the backend Docker image).
- **`src/db/`** is the database package (it replaces the old `src/db.js`):
  - **`schema/*.ts`** — Drizzle table definitions, 46 tables split across `auth`/`infra`/`vms`/`network`/`web`/`workflows`/`ops`. Columns are snake_case (property keys match column names, so rows serialize straight into API JSON), booleans are real booleans, timestamps are `timestamptz`, structured data is `jsonb`, and binary is `bytea`. Table export names are camelCase.
  - **`client.ts`** — the shared `pg.Pool` and `drizzle` instance. Import `{ db }` from here everywhere; don't construct pools elsewhere.
  - **`migrate.ts`** — a tiny runner that applies the numbered SQL files in `backend/drizzle/*.sql` in order, inside one advisory-locked transaction, recording each in `schema_migrations`.
  - **`init.ts`** — `initDatabase()`: runs migrations, asserts the secret-encryption key, seeds the built-in roles, adopts legacy plaintext/`v1` secrets, reconciles interrupted operations, and bootstraps the first admin. Called once from `index.ts`.
  - **`sessionStore.ts`** — the Drizzle-backed express-session store (it replaced `better-sqlite3-session-store`; the prune timer is owned here so it stops cleanly on shutdown).
  - **`errors.ts`** — `isUniqueViolation(err)` / `isForeignKeyViolation(err)` branch on the PG SQLSTATE codes `23505`/`23503`, never on message text.
  - **`settings.ts`** — the sanctioned `getSetting`/`setSetting` upsert for the key/value `settings` table.
- **Schema changes**: edit `src/db/schema`, run `npm run db:generate` to emit a new numbered SQL file in `backend/drizzle/`, then **hand-trim it** — drizzle-kit output is a draft, not gospel (for example it re-emits the runner-owned `schema_migrations` table, which must be removed). The file applies on the next boot. **Never edit an already-applied migration**; add a new numbered file instead. There is no more inline `CREATE TABLE IF NOT EXISTS` / `try…catch ALTER` pattern.
- **`src/proxmox.ts`** — multi-host Proxmox client. Every request resolves which registered `pve_hosts` row to use. Auth is a PVE API token (`PVEAPIToken=...`). TLS verification is per-host (`verify_tls`); `assertSecureTls` refuses insecure hosts unless `ALLOW_INSECURE_UPSTREAM_TLS=true`.
- **`src/fortigate.ts`** — FortiGate REST client (VLANs, policies, VIPs/port-forwards, DHCP, switch discovery).
- **`src/routes/*`** — one router per domain (`auth`, `admin`, `vms`, `ssh`, `sftp`, `provision`, `cloudimages`). Routers apply `requireAuth` at the top and gate individual handlers.
- **`src/utils/`** — cross-cutting helpers. Notably `secrets.ts` (AES encryption at rest, `enc:v2:<key-id>:` envelope), `audit.ts` (`logAudit`), `capacity.ts` (pre-flight node memory/storage checks), `cpuTopology.ts`, `vmTags.ts` (stamps owner/VLAN as PVE tags), `sshHostKey.ts` (host-key fingerprint verification), `sanitize.ts` (`sanitizeError` scrubs leaked details before returning 500s).

### node references — important
A "node" identifier in this codebase is **not** a bare Proxmox node name. Because VMIDs are globally unique across multiple clusters, nodes are encoded as `"<hostId>~<nodeName>"` (see `utils/nodeRef.js`, present in **both** backend and frontend). Always round-trip node values through `decodeNodeRef` / `encodeNodeRef` / `nodeLookupCandidates` rather than string-splitting by hand. DB lookups that match on `node` must try all `nodeLookupCandidates` (legacy rows may store the bare name).

### authorization model
Two layers, both admin-bypassed:
- **Route middleware** (`middleware/auth.ts`): `requireAuth`, `requireAdmin`, and `requirePermission('can_manage_x', ...)` which passes if the user is admin OR any listed `can_*` column is `true`. The granular permission columns live on the `users` table.
- **VM-level access** (`utils/vmOps.ts` + `utils/vmAccess.ts`): every VM route calls `userCanPerformVmOp(userId, node, vmid, isAdmin, op)` with an op key from the `VM_OP_TIERS` table in `utils/vmOps.ts` (pure, unit-tested in `vmOps.test.ts`). Three tiers: `read` (assignment OR `see_all_vms` OR `can_operate_all_vms`), `operate` (assignment OR `can_operate_all_vms` — power, console/SSH/SFTP, snapshots, backups, VLAN/hardware, DHCP), and `own` (strict assignment only — delete, restore, snapshot rollback, cloud-init creds, lease renewal, schedule edits). Add a new route by adding its op to the table, not by hand-rolling a check. `userCanAccessVm`/`userOwnsVm` remain for non-route callers.

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

The full contract for converted modules lives in [`backend/docs/postgres-conventions.md`](backend/docs/postgres-conventions.md) — read it before touching the db layer. In short:

- Match existing style: ESM + TypeScript with `.ts` import specifiers, **async Drizzle** calls (always `await`ed), one router per domain, one axios instance, node values always encoded/decoded via `nodeRef`.
- Run multi-statement work in a transaction: `await db.transaction(async (tx) => …)`, and put **every** statement on `tx` (not the outer `db`).
- Detect a duplicate with `isUniqueViolation(err)` from `db/errors.ts` — never string-match the driver message. Use real booleans (not `0`/`1`), `Date` objects for timestamps, and plain objects for `jsonb` columns.
- Change the schema by editing `src/db/schema`, running `npm run db:generate`, hand-trimming the new numbered SQL file under `backend/drizzle/`, and letting it apply on boot. Never edit an applied migration; add a new numbered file.
- Return errors through `sanitizeError` on 500 paths; log meaningful admin actions with `logAudit`.
- Local commands are shown in PowerShell; the DB is PostgreSQL (`$env:DATABASE_URL=...`).
