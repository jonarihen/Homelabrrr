# Homelabrrr

> Self-service homelab portal for Proxmox and FortiGate

[![Frontend](https://img.shields.io/badge/frontend-React%2018%20%2B%20Vite-61dafb?style=flat-square&logo=react&logoColor=white)](#stack)
[![Backend](https://img.shields.io/badge/backend-Node.js%20%2B%20Express-339933?style=flat-square&logo=node.js&logoColor=white)](#stack)
[![Database](https://img.shields.io/badge/database-SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white)](#stack)
[![Deployment](https://img.shields.io/badge/deployment-Docker%20Compose-2496ed?style=flat-square&logo=docker&logoColor=white)](#quick-start)
[![Security](https://img.shields.io/badge/security-TOTP%202FA%20%2B%20role%20controls-bf3989?style=flat-square)](#security-model)

Homelabrrr is a web portal for running a self-service Proxmox environment with FortiGate-backed networking.
Users get assigned VM/LXC access, browser VNC, browser SSH, SFTP file access, provisioning, and account management.
Admins get a single interface for Proxmox hosts, FortiGate firewalls, VLANs, policies, port forwards, assignments, users, and audit history.

It is built for homelab deployment behind a reverse proxy such as Nginx Proxy Manager.
The frontend serves internal HTTP, and TLS is expected to terminate at the proxy layer.

## Why This Exists

Most homelabs end up split across several tools:

- Proxmox for compute
- FortiGate for networking
- spreadsheets or notes for assignments
- ad-hoc access management

This project pulls those into one interface so users can work inside guardrails instead of getting raw platform access.

## Highlights

| Area | What you get |
| --- | --- |
| VM & LXC access | Assigned VM/container listing, status/actions, browser VNC, snapshots, backups grouped by storage (with PBS encryption/verification status), and file-level backup restore |
| Power schedules | Per-VM automatic stop/start windows (e.g. stop 23:00, start 08:00 on weekdays) enforced by a minute-granularity background loop: graceful shutdown with a hard-stop fallback, timezone- and day-aware evaluation, manual-override-wins semantics, a "skip tonight" one-off, and a "sleeps 23:00–08:00" badge on the card/detail page — every action audit-logged |
| Console workflow | Floating multi-session SSH/VNC console dock with minimize/restore, tiling, pop-out tabs, and clipboard paste into VNC (typed into the guest as keystrokes, no agent needed) |
| SSH & SFTP | Browser SSH terminal, uploaded encrypted keys, host-key verification, and SFTP upload/download/file management |
| Provisioning | Deploy straight from a cloud image, clone a template, or build a VM from scratch / from an available ISO — from-scratch is available to admins and to users holding the **Create VMs** permission (non-admins are pinned to the default bridge and self-assigned the VM) — all with CPU topology validation, `cpu=host`, VLAN picker, GB-based memory, pre-flight capacity checks (node free memory + storage space), per-user resource quotas (cores/memory/storage, enforced on creation and hardware upgrades), and a live step-by-step deployment progress stepper |
| Cloud images | Managed cloud image catalog (Ubuntu/Debian/Rocky presets or custom URLs) as the provisioning source: deploy a new VM directly from an image with `import-from` (no static template needed), configuring guest user, SSH keys, and DHCP/static network via cloud-init on first boot; optional one-click conversion to a reusable template remains (requires a storage with the Import content type; PVE 9) |
| ISO catalog | Download installer ISOs by URL — Proxmox fetches them onto a storage as `iso` content with live download-progress polling; list with size/status and remove (deletes the PVE volume and the row). Same SSRF URL guard as cloud images; ready ISOs feed the from-scratch create-VM picker |
| VM leases | Per-VM expiry so the lab doesn't fill with zombie VMs: a lease starts at provisioning, owners see a countdown ("Expires in 12 days") and renew in one click, and a background sweep gracefully stops (never deletes) expired VMs, then surfaces them in an admin reclaimable list after a grace period. Admins set the default duration/grace, exempt infra VMs, and adjust/extend any lease |
| Networking | VLAN management with user-scoped access, FortiGate sync, managed/tagged-only VLAN modes, DHCP lease visibility, and IP reservations |
| Tag auto-sync | Owner + VLAN tags are re-stamped on every VM automatically in the background on a schedule (default every 6h), correcting drift from raw PVE tag edits, renamed VLANs, or migrations — with an admin pause switch (persists across restarts), a configurable interval, live force-sync progress, and last-run / per-VM-failure visibility |
| Port forwarding | FortiGate WAN/VIP policy creation with scoped access for assigned VMs and VLANs |
| Website publishing | Self-service reverse-proxy publishing through an external Caddy server: DNS-validate a domain against the homelab WAN IP, push an `@id`-tagged route via the Caddy admin API, let Caddy obtain a Let's Encrypt cert, and attach the synced cert to the FortiGate SSL/SSH inspection profile — with per-user ownership and upstream-target restrictions |
| Provisioning workflows | Configurable per-firewall workflow engine driving VLAN/port-forward/policy provisioning: reorder, toggle, and parametrize whitelisted steps (or add a raw `/api/v2/` call), preview the exact API calls with a dry-run, and view a per-run log. Defaults reproduce the built-in sequences exactly; deprovision is artifact-based (removes what a run created, in reverse), and failed runs roll back |
| Multi-host | Multiple Proxmox hosts with globally unique VMIDs across all connected clusters |
| Storage exposure | Admins pick which Proxmox storage pools users may deploy onto, per host; hidden pools vanish from the provisioning dropdowns and are rejected server-side. Every pool is exposed by default, so nothing changes until you restrict one |
| Node maintenance | Soft-drain a Proxmox node before a planned reboot/upgrade: new provisioning to it is blocked with a clear reason, the node is greyed out in pickers, an Overview notice is auto-published for every user, and health shows amber "maintenance" (not red "down"). Running VMs are untouched, and maintenance can auto-expire at a set end time |
| Admin delegation | Role-based access control: named roles bundle the granular permission flags (hosts, firewalls, port forwards, VLANs, policies, templates, users, assignments, audit log, VM hardware, provisioning, VM visibility). A role fully defines its holder's permissions; users without a role use per-user flags |
| Onboarding | One-time **invite links**: generate a shareable URL preloaded with a role/permissions, quotas, VLAN access, expiry, and optional required-2FA; the invitee self-registers (username + password), enrolls 2FA if required, and lands in the portal with exactly the preset access — no manual account creation or out-of-band password handoff |
| Notifications | Discord webhook notifications for deployments, backups, node health, notices, and security events — configured per channel with per-event routing, a send-test button, encrypted webhook URLs, and per-user opt-out |
| API tokens | Personal `Authorization: Bearer` tokens for scripting (curl, cron, CI) with the owner's exact permissions and quotas — shown once, stored hashed, optionally expiring, revocable, and fully attributed in the audit log |
| Security | Session auth, TOTP 2FA, login throttling, secrets encrypted at rest, upstream TLS enforcement, SSH host-key checks, audit logging |

## UI Overview

### User side

- `My VMs` — assigned VM/LXC inventory with search, filter, sort, selection, and bulk actions
- `New VM` — deploy directly from a cloud image (no template needed), template-driven cloning for permitted users, and build-from-scratch (from an available ISO) for admins and users with the **Create VMs** permission, each with a live deployment progress stepper
- `New VM` — deploy directly from a cloud image (no template needed), template-driven cloning for permitted users, and create-from-scratch for admins, each with a live deployment progress stepper
- `Websites` — publish a domain through the homelab reverse proxy: DNS check → route pushed to Caddy → Let's Encrypt cert → cert attached to FortiGate SSL inspection, shown as a live step-progress flow; users see and manage only their own sites
- `VM Detail` — status, power actions, performance graphs, browser VNC/SSH, SSH config, IP management, snapshots, backups, and file-level restore; backups are grouped per storage location and show encryption, verification, and protection status for PBS-backed stores
- `Power Schedule` — from a VM's detail page, set an automatic stop/start window (stop time, start time, active days, timezone) so idle VMs sleep overnight; manually starting inside the off-window keeps the VM up until the next scheduled stop, and a "skip tonight" button skips just the next shutdown
- `Console Dock` — multiple VNC/SSH sessions that can be minimized, restored, tiled, or popped out to standalone tabs; VNC consoles have a Paste button that types the clipboard into the guest (SSH terminals take native browser paste)
- `SSH Keys` — uploaded keys used by browser SSH and SFTP sessions
- `Account` — password, 2FA management, personal API token management (create/list/revoke), and a notification opt-out toggle for events about your own resources

### Admin side

- `PVE Hosts` — multi-host Proxmox registration with status monitoring, per-host **storage pool exposure** toggles (choose which pools users may deploy onto), and per-node **maintenance mode** (soft drain): a Drain button per node takes an optional reason and expected end time, blocks new provisioning to that node, auto-publishes an Overview notice, and shows the node amber; maintenance lifts itself at the end time or when ended manually
- `Templates` — register source VMs with auto-populated defaults from Proxmox config; cloud image catalog with downloads used as the direct provisioning source (deploy VMs straight from an image) plus optional one-click cloud-init template builds; and an ISO catalog to download installer ISOs by URL for from-scratch installs
- `Firewalls` — FortiGate registration, VDOM/link settings, WAN settings, and managed-switch discovery
- `Workflows` — per-firewall, per-trigger provisioning flows (VLAN provision/deprovision, port-forward create/delete, policy create/delete): drag-to-reorder step cards, per-action parameter forms with a variable picker, enable/disable and continue-on-error toggles, subnet-derivation setting, a dry-run preview of the exact API calls, and a run-log viewer
- `VLANs` — managed or tagged-only network definitions, subnet data, and FortiGate sync
- `Policies` — visual traffic mesh plus address/service object management for admins
- `Port Forwarding` — WAN VIP and firewall policy management, scoped for delegated users
- `Assignments` — VM and VLAN-to-user mapping, grouped per user with unassigned VMs listed first; unassigned VMs can be claimed for your own account (per VM, or all at once — handy for fleets that predate the portal); owner + VLAN are stamped as Proxmox tags on each VM so ownership is visible in the PVE UI too. A **PVE Tag Auto-Sync** card runs the fleet-wide tag sync automatically in the background (default every 6h) and lets an admin pause/resume it, change the interval, and force an on-demand sync with live progress and last-run / failure visibility
- `Users` — accounts, role assignment (or per-user permissions when no role is set), resource quotas (max cores/memory/storage) with live usage, VM/VLAN assignments, personal API token oversight (list/revoke), lockout unlocks, and enforced 2FA
- `Invites` — generate one-time self-registration links (choose role/permissions, quotas, VLAN access, expiry, and optional required-2FA); copy the single-use URL, track open/used/expired/revoked invites, and revoke unused ones. Tokens are stored hashed and every generate/consume/revoke is audit-logged
- `Websites` — register the external Caddy server (admin API URL, optional auth, TLS verify), set the homelab WAN IP (manual or auto-read from the linked FortiGate), pick the SSL/SSH inspection profile, and see every published site with its owner (with reassignment)
- `Assignments` — VM and VLAN-to-user mapping, grouped per user with unassigned VMs listed first; unassigned VMs can be claimed for your own account (per VM, or all at once — handy for fleets that predate the portal); owner + VLAN are stamped as Proxmox tags on each VM (with a bulk "Sync PVE Tags" action) so ownership is visible in the PVE UI too
- `Users` — accounts, role assignment (or per-user permissions when no role is set), resource quotas (max cores/memory/storage) with live usage, VM/VLAN assignments, lockout unlocks, and enforced 2FA
- `Roles` — named permission sets (built-in Administrator/User plus custom roles); editing a role updates every user holding it
- `VM Leases` — set the default lease duration + grace period, review every VM's lease with owner and live status, renew/adjust/extend any lease, exempt infra VMs, run the expiry sweep on demand, and backfill leases onto VMs that predate the feature; expired-past-grace VMs are highlighted as reclaimable
- `Notifications` — add Discord webhooks, choose which event types each one receives, and send a test message; webhook URLs are encrypted at rest and all changes are audit-logged
- `Audit Log` — change tracking with user/IP/timestamp
- `Changelog` — recent platform changes shown from the sidebar for every signed-in user

## Architecture

```mermaid
flowchart LR
    U[Browser] --> RP[Reverse Proxy / TLS]
    RP --> FE[Frontend<br/>React + Vite + Nginx]
    FE --> BE[Backend<br/>Express + WebSocket proxy]
    BE --> DB[(SQLite)]
    BE --> PVE[Proxmox VE API]
    BE --> FGT[FortiGate API]
```

## Stack

- Frontend: React 18, Vite 5, Tailwind CSS 3, React Router 6
- Backend: Node.js 20 (ESM), Express, `ws`, `ssh2`, `multer`
- Database: SQLite via `better-sqlite3` (encrypted secrets at rest)
- Auth: SQLite-backed session cookies, rate-limited login/2FA, TOTP 2FA
- Console access: Proxmox VNC websocket proxy via noVNC, plus browser SSH via `xterm.js`
- File access: SFTP over `ssh2`, sharing the SSH credential and host-key verification flow
- Integrations: Proxmox VE API (multi-host), FortiGate REST API
- Deployment: Docker Compose (two containers — backend + frontend/nginx)

## Screens and Flow

The current UI is built around a left navigation shell with focused task pages:

- VM dashboard for daily user operations
- docked/floating VNC and SSH sessions with standalone tab routes
- SFTP file browsing inside connected SSH sessions
- VM detail pages with IP reservation, snapshot, backup, restore, and hardware-edit workflows
- admin pages split into Infrastructure, Networking, and Access sections
- a visual policy mesh for understanding VLAN relationships

If you want this README to include actual screenshots, add image files under something like `docs/` and link them here.

## Port Forwarding Notes

Managed custom port forwards are named with the target service port and protocol, for example `Minecraft - Custom 25565/tcp`.
The created FortiGate policies use the same base name through the existing `PF: ...` policy prefix.

Compatibility with existing installs:

- existing managed VIPs and policies are not renamed or migrated
- old names such as `Minecraft - Custom` continue to be listed, deleted, and cleaned up by their stored `vip_name` and `service_name`
- new custom forwards can target the same VM when the internal port/protocol is different
- duplicates are blocked for the same firewall, internal IP, internal port, and protocol
- the WAN external port/protocol must still be unique on the firewall

## API Tokens

Personal API tokens let you script against the portal without a browser session or 2FA prompt. Create one under **Account → API Tokens** (name + optional expiry); the plaintext secret is shown **once** — copy it then. Only its SHA-256 hash is stored.

Use it with a standard `Authorization: Bearer` header:

```bash
# List the VMs your account can see
curl -H "Authorization: Bearer hlr_your_token_here" https://portal.example.com/api/vms
```

A token carries **exactly** its owner's permissions, VM ownership, and quotas, resolved live on every request — it is never more powerful than the user, and revoking it (or the user losing a permission) takes effect immediately. Every token request is attributed in the audit log as `username (token: <name>)`.

Interactive-session-only endpoints reject token auth: managing API tokens, changing your password, and anything touching 2FA. The VNC/SSH console websockets also remain session-only. Admins can list and revoke any user's tokens from **Users → Manage → API Tokens**.
## Website Publishing (Caddy + FortiGate SSL inspection)

Homelabrrr can drive an **external [Caddy](https://caddyserver.com/) reverse proxy** so users publish their own websites without an admin hand-editing the Caddy config. Caddy runs bare-metal on its own VM; Homelabrrr manages it entirely through the **Caddy admin API** (default `:2019`).

### How it works

1. An admin registers the Caddy server once on **Admin → Websites** (admin API URL, optional auth, TLS-verify), links a FortiGate, and sets the **homelab WAN IP** (typed manually or auto-read from the linked FortiGate's WAN interface / stored external IP). Optionally the admin picks the FortiGate **SSL/SSH inspection profile** to wire certs into.
2. A user opens **Websites**, enters a domain, and picks an upstream target (address + port).
3. Homelabrrr resolves the domain's **A record** (following CNAMEs) and checks it matches the homelab WAN IP. On a mismatch it says exactly what to point where.
4. It builds the reverse-proxy route **JSON server-side** from the validated fields and pushes it to Caddy as an `@id`-tagged route (`homelabrrr-<site-id>`), so each site is created/updated/deleted individually and Homelabrrr **never touches a route it did not create**.
5. Caddy obtains a **Let's Encrypt** certificate for the domain. The Caddy host runs [`caddy-forticertsync`](https://github.com/jonarihen/caddy-forticertsync), which syncs every issued/renewed cert into the FortiGate certificate store automatically.
6. Homelabrrr finds the synced cert and attaches it to the FortiGate **SSL/SSH inspection profile** (`firewall/ssl-ssh-profile`, `server-cert`) so inbound inspection presents the real certificate.

The whole flow is shown as a live step-progress stepper (DNS → route pushed → cert issued → inspection wired → live), and each step's state is persisted so it survives a page refresh.

### Guardrails

- **Ownership** — users see and manage only their own sites; admins see all sites with the owner shown and can reassign ownership.
- **Upstream restriction** — a non-admin may only proxy to a target they own: the IP of a VM assigned to them, or an address inside one of their VLAN subnets. Admins are exempt.
- **Domain uniqueness** — a domain already published by another user cannot be claimed again.
- **No raw config injection** — users never submit Caddyfile/JSON; the domain is validated against a strict hostname regex and the upstream against IP/host + port validation, and the route JSON is assembled server-side.
- **Rate limiting + audit** — DNS-validation checks are rate-limited, and every site create/update/delete and every ownership assignment is written to the audit log.
- The **`can_manage_websites`** permission (grantable per user or via a role) gates the admin surface (server registration, all-sites view, assignment, WAN-IP config). Any authenticated user can publish their own sites once a Caddy server is registered.

### ⚠️ Secure the Caddy admin API

**The Caddy admin API is unauthenticated by default.** Anyone who can reach `:2019` has full control of Caddy's configuration. Before registering it:

- Bind the admin API to an interface on a **management VLAN** that only Homelabrrr's backend can reach (Caddy's `admin` directive `listen`), **not** `0.0.0.0`.
- Or front it with **mTLS / a token-checking reverse proxy** and register that endpoint (Homelabrrr can send a `Bearer`/`Basic`/raw `Authorization` header — encrypted at rest — for such a fronting proxy).
- **Never** expose `:2019` to the internet or any untrusted network.

Registered Caddy credentials, like all upstream secrets, are encrypted at rest. If the admin API URL is `https://` with a self-signed cert, TLS-verify can only be disabled when `ALLOW_INSECURE_UPSTREAM_TLS=true` is set (same policy as Proxmox/FortiGate).

## Quick Start

### 1. Create your environment file

```bash
cp .env.example .env
```

Then set at least:

- `SESSION_SECRET` to a long random value
- `SECRET_ENCRYPTION_KEY` to a 32-byte base64, hex, or raw text key (used to encrypt secrets at rest)
- `ALLOWED_ORIGIN` to your public portal URL
- `COOKIE_SECURE` only if you need to opt out: session cookies are marked `Secure` by default, set `COOKIE_SECURE=false` only for plain-HTTP dev setups

If the database is brand new and empty, also set:

- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_PASSWORD`

Those bootstrap values are only used to create the first admin account on first run.

### 2. Build and start

```bash
docker compose up -d --build
```

The frontend is published on `http://localhost:8181` by default.
The backend health check is available through the frontend proxy at `http://localhost:8181/api/health`.

### 3. Put it behind a reverse proxy

Recommended model:

- TLS terminates at Nginx Proxy Manager or another reverse proxy
- the proxy forwards traffic to the frontend container
- the frontend nginx container proxies `/api/*` and websocket upgrades to the backend over the internal Docker network

By default, the frontend is published on port `8181` and bound to `127.0.0.1` (loopback only, matching `.env.example`).
Set `FRONTEND_BIND_ADDRESS=0.0.0.0` if the reverse proxy runs on another host and needs to reach the UI directly.

## Local Development

Docker Compose is the normal deployment path. For local frontend/backend development:

```powershell
cd backend
npm install
New-Item -ItemType Directory -Force data
$env:SESSION_SECRET="dev-session-secret"
$env:SECRET_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"
$env:INITIAL_ADMIN_USERNAME="admin"
$env:INITIAL_ADMIN_PASSWORD="change-this-before-first-start"
$env:DB_PATH="./data/db.sqlite"
node src/index.js
```

In another shell:

```powershell
cd frontend
npm install
npm run dev
```

Vite proxies `/api` and websocket traffic to `http://localhost:3000`.

## Environment

Example values live in [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session signing secret |
| `SECRET_ENCRYPTION_KEY` | 32-byte master key for encrypting secrets at rest; accepted as base64, 64-char hex, or exactly 32 bytes of raw text |
| `ALLOWED_ORIGIN` | Exact public browser origin allowed for CORS and websocket upgrades |
| `COOKIE_SECURE` | Marks auth cookies as `Secure` (default `true`; set to `false` only for plain-HTTP local dev) |
| `TRUST_PROXY` | Number of proxy hops in front of the backend (default `2`: external reverse proxy + bundled nginx; set `1` if clients reach port 8181 directly) |
| `ALLOW_INSECURE_UPSTREAM_TLS` | Break-glass override for self-signed Proxmox/FortiGate certs (default `false`) |
| `ALLOW_INTERNAL_IMAGE_URLS` | Allow cloud-image and ISO downloads from internal/reserved addresses, e.g. an internal mirror (default `false`) |
| `PORTAL_BASE_URL` | Absolute portal URL used for "open in portal" links in Discord embeds (falls back to `ALLOWED_ORIGIN`; links omitted if neither is set) |
| `NODE_HEALTH_POLL_MS` | Interval for the background Proxmox health monitor that emits node unreachable/recovered notifications (default `60000`; `0` disables it) |
| `INITIAL_ADMIN_USERNAME` | First admin username for empty DB bootstrap |
| `INITIAL_ADMIN_PASSWORD` | First admin password for empty DB bootstrap |
| `FRONTEND_BIND_ADDRESS` | Host bind address for frontend publishing (default `127.0.0.1`; set `0.0.0.0` to expose on all interfaces) |
| `LEASE_CHECK_INTERVAL_MS` | How often the background VM-lease sweeper runs to gracefully stop expired VMs (default `900000` = 15 min; minimum `60000`). Default lease duration and grace period are set in-app on the admin VM Leases page |
| `VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS` | How long a scheduled graceful shutdown waits before the hard-stop fallback fires (default `120000`) |

Useful implementation defaults:

- backend listens on port `3000` inside Docker
- frontend nginx listens on port `80` inside Docker and publishes host port `8181`
- SQLite data is stored in the `db_data` Docker volume at `/app/data/db.sqlite`
- SFTP uploads are capped at 100 MB per file by the frontend nginx/backend upload path

## Security Model

Current hardening in the codebase includes:

- no hardcoded default admin user on fresh install
- optional mandatory 2FA enrollment
- 2FA lifecycle protection: starting a new enrollment cannot silently disable an active second factor, admin 2FA resets require confirmation, and setup/enable/disable/reset are audit-logged
- login and 2FA attempt throttling, with admin unlock support
- invite links are single-use and rate-limited like login; only a SHA-256 hash of the token is stored (the raw token is shown to the admin once), and redemption creates the account inside a single transaction that applies the preset and marks the invite consumed atomically
- personal API tokens are stored only as SHA-256 hashes (plaintext shown once at creation), resolve the live user on every request so they never exceed their owner's permissions, are rate-limited on failure, cannot perform interactive-only operations (token/password/2FA management), do not extend to the VNC/SSH websockets, and are attributed by token name in the audit log
- assignment-aware VM access (users only see their own VMs)
- backup browse, download, restore, and delete verify that the named backup volume actually belongs to the VM being operated on (the VMID embedded in the volid must match; unparseable volids are rejected)
- destructive operations (VM deletion, backup deletion, backup restore) require strict VM ownership — the see-all-VMs visibility flag does not grant them
- Proxmox node names are validated against a strict DNS-label pattern and URL-encoded before being interpolated into upstream API paths, so a crafted node name can't steer requests made with the privileged PVE API token (path injection / SSRF)
- per-VM SSH authorization, stored destination config, and SSH host-key verification
- SFTP access reuses the same authenticated SSH session setup and host-key checks as terminal access
- secrets encrypted at rest with `SECRET_ENCRYPTION_KEY` (API tokens, SSH keys, TOTP secrets)
- upstream TLS enforcement for Proxmox and FortiGate connections (with explicit break-glass override)
- per-host Proxmox TLS verification settings
- granular admin permissions for delegation (10 independent flags)
- user-scoped VLAN, policy, and port-forward management
- storage pool exposure is enforced server-side on every create path (clone, from-image, from-scratch), not just hidden in the UI — a non-admin naming a hidden pool directly is rejected; pools are exposed by default so existing setups are unchanged until an admin restricts one, and every toggle is audit-logged
- hardware editing is separately permission-gated and audit-logged
- audit logging for all significant actions with user/IP/timestamp
- error message sanitization (strips internal IPs and paths from API responses)
- CORS/websocket origin checks tied to `ALLOWED_ORIGIN` or same-origin access, plus secure cookies and nginx security headers

Operationally important:

- The frontend is plain HTTP inside Docker by design.
  Put TLS at the reverse proxy.
- The SQLite volume contains sensitive operational data encrypted at rest.
  Back it up and protect it.
- SSH private keys are stored encrypted in the application database for browser terminal access.
  Treat the DB as sensitive.

## Reverse Proxy Notes

This project is intended to run like this:

1. Internet traffic hits your reverse proxy
2. The reverse proxy handles HTTPS
3. The proxy forwards requests to the frontend container
4. The frontend proxies API and websocket traffic to the backend

That matches a homelab setup where the app itself stays internal and the public edge is handled elsewhere.

Proxy requirements:

- forward normal HTTP requests and websocket upgrades for `/api/*`
- preserve `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`
- set `ALLOWED_ORIGIN` to the exact external URL, for example `https://portal.example.com`
- keep `COOKIE_SECURE` at its secure default (`true`) — the `Secure` cookie flag must stay on behind the TLS-terminating proxy

## Repo Layout

```text
backend/              Express API, websocket proxies, DB schema, integrations
frontend/             React SPA, admin pages, policy mesh UI, nginx config
CHANGELOG.md          Release notes, also shown inside the admin UI
docker-compose.yml    Main deployment entrypoint
.env.example          Safe environment template
```

## Versioning and Rollback

Git gives you code history and rollback.
It does not roll back:

- the SQLite database volume
- saved credentials inside the DB
- firewall changes already pushed to FortiGate
- Proxmox-side changes already applied

If you want safe rollback in practice, pair Git with database backups and network config backups.

## Changelog

Recent changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).
Admins can also open the changelog directly from the sidebar in the UI.
