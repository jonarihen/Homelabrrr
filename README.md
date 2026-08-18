# Homelabrrr

> Self-service homelab portal for Proxmox and FortiGate

[![Frontend](https://img.shields.io/badge/frontend-React%2018%20%2B%20Vite-61dafb?style=flat-square&logo=react&logoColor=white)](#stack)
[![Backend](https://img.shields.io/badge/backend-Node.js%20%2B%20Express-339933?style=flat-square&logo=node.js&logoColor=white)](#stack)
[![Database](https://img.shields.io/badge/database-PostgreSQL-4169e1?style=flat-square&logo=postgresql&logoColor=white)](#stack)
[![Deployment](https://img.shields.io/badge/deployment-Docker%20Compose-2496ed?style=flat-square&logo=docker&logoColor=white)](#quick-start)
[![Security](https://img.shields.io/badge/security-passkeys%20%2B%20role%20controls-bf3989?style=flat-square)](#security-model)

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
| Cloud-init recovery | Owners of a cloud-init VM can self-service **reset the cloud-init password and/or SSH public key** (picked from stored keys or pasted), with an inline reboot to apply — no admin round-trip, no secret ever stored |
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
| Admin delegation | Role-based access control: named roles bundle the granular permission flags (hosts, firewalls, port forwards, VLANs, policies, templates, users, assignments, audit log, VM hardware, provisioning, read-only VM visibility, fleet-wide VM operation). A role fully defines its holder's permissions; users without a role use per-user flags |
| Onboarding | One-time **invite links**: generate a shareable URL preloaded with a role/permissions, quotas, VLAN access, expiry, and optional required-2FA; the invitee self-registers (username + password), enrolls 2FA if required, and lands in the portal with exactly the preset access — no manual account creation or out-of-band password handoff |
| Notifications | Discord webhook notifications for deployments, backups, node health, notices, and security events — configured per channel with per-event routing, a send-test button, encrypted webhook URLs, and per-user opt-out |
| API tokens | Personal `Authorization: Bearer` tokens for scripting (curl, cron, CI) with explicit least-privilege scopes, optional expiry, one-time secret display, live owner permissions, and full audit attribution |
| Security | Session auth, TOTP plus WebAuthn/passkeys and one-time recovery codes, active-session revocation, origin/CSRF checks, login throttling, versioned encryption keys, upstream TLS enforcement, SSH target/host-key checks, and outcome-aware audit logging |

## UI Overview

### User side

- `My VMs` — assigned VM/LXC inventory with search, filter, sort, selection, and bulk actions
- `New VM` — deploy directly from a cloud image (no template needed), template-driven cloning for permitted users, and build-from-scratch (from an available ISO) for admins and users with the **Create VMs** permission, each with a live deployment progress stepper
- `Websites` — publish a domain through the homelab reverse proxy: DNS check → route pushed to Caddy → Let's Encrypt cert → cert attached to FortiGate SSL inspection, shown as a live step-progress flow; users see and manage only their own sites
- `VM Detail` — status, power actions, performance graphs, browser VNC/SSH, SSH config, IP management, snapshots, backups, and file-level restore; backups are grouped per storage location and show encryption, verification, and protection status for PBS-backed stores. Cloud-init VMs you own also get a **Reset credentials** action to set a new password / SSH key (with an inline reboot to apply)
- `Power Schedule` — from a VM's detail page, set an automatic stop/start window (stop time, start time, active days, timezone) so idle VMs sleep overnight; manually starting inside the off-window keeps the VM up until the next scheduled stop, and a "skip tonight" button skips just the next shutdown
- `Console Dock` — multiple VNC/SSH sessions that can be minimized, restored, tiled, or popped out to standalone tabs; VNC consoles have a Paste button that types the clipboard into the guest (SSH terminals take native browser paste)
- `SSH Keys` — uploaded keys used by browser SSH and SFTP sessions
- `Account` — password and TOTP management, named passkeys, one-time recovery codes, active-session revocation, scoped personal API tokens, and a notification opt-out toggle for events about your own resources

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
- `Roles` — named permission sets (built-in Administrator/User plus custom roles); editing a role updates every user holding it
- `VM Leases` — set the default lease duration + grace period, review every VM's lease with owner and live status, renew/adjust/extend any lease, exempt infra VMs, run the expiry sweep on demand, and backfill leases onto VMs that predate the feature; expired-past-grace VMs are highlighted as reclaimable
- `Notifications` — add Discord webhooks, choose which event types each one receives, and send a test message; webhook URLs are encrypted at rest and all changes are audit-logged
- `Audit Log` — change tracking with user/IP/timestamp
- `Operations` — interrupted Proxmox task reconciliation, encrypted backup/restore-verification status, PostgreSQL retention/maintenance, and secret-key rotation planning
- `Changelog` — recent platform changes shown from the sidebar for every signed-in user

## Architecture

```mermaid
flowchart LR
    U[Browser] --> RP[Reverse Proxy / TLS]
    RP --> FE[Frontend<br/>React + Vite + Nginx]
    FE --> BE[Backend<br/>Express + WebSocket proxy]
    BE --> DB[(PostgreSQL)]
    BE --> PVE[Proxmox VE API]
    BE --> FGT[FortiGate API]
```

## Stack

- Frontend: React 18, Vite 8, Tailwind CSS 3, React Router 7
- Backend: Node.js 26 (ESM + TypeScript, run directly via native type stripping — no build step), Express 5, `ws`, `ssh2`, `busboy`
- Database: PostgreSQL 17, accessed through **Drizzle ORM** over **node-postgres (`pg`)** with a shared connection pool (encrypted secrets at rest)
- Auth: Drizzle-backed PostgreSQL session store, rate-limited login/2FA, TOTP, WebAuthn/passkeys, recovery codes, and scoped bearer tokens
- Console access: Proxmox VNC websocket proxy via noVNC, plus browser SSH via `xterm.js`
- File access: SFTP over `ssh2`, sharing the SSH credential and host-key verification flow
- Integrations: Proxmox VE API (multi-host), FortiGate REST API
- Deployment: Docker Compose (three services — `postgres` + backend + frontend/nginx)

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

A token is limited twice: by its selected scopes (`read`, `vm:operate`, `infrastructure:write`, or the deliberately high-risk `admin`) and by its owner's live permissions, VM ownership, and quotas. Infrastructure writes cover cloud images/ISOs, notifications, portal notices/links, public IPs, websites, and workflow configuration; mutations below `/api/admin` always require the `admin` scope as well as the owner's matching permission. Existing pre-scope tokens migrate to `read` only. Revocation or a user permission change takes effect immediately, and every token request is attributed in the audit log as `username (token: <name>)`.

Identity endpoints reject token auth regardless of scope: users, roles, permissions, invites, passwords, passkeys, recovery codes, sessions, and 2FA remain interactive-session only. Sensitive browser mutations ask for the password and current TOTP again when the 15-minute re-authentication window has expired. VNC/SSH console websockets also remain session-only. Admins can list and revoke any user's tokens from **Users → Manage → API Tokens**.
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

### What "live" means

A site is marked **live** only after Homelabrrr has made a real HTTPS request to the published domain and seen it answer. Two checks stand between "the admin API accepted the route" and that badge:

- **Conflict detection.** After pushing, the live route array is read back. Caddy evaluates each server's routes in order and a `reverse_proxy` site block is `terminal`, so the *first* route matching a hostname wins — and `POST …/routes` appends. A hand-written Caddyfile block for the same hostname therefore always beats a route pushed later. When one is found, the site is marked **conflict** with the winning route's upstream named in the stepper. That foreign route is never deleted or rewritten (Homelabrrr only ever touches its own `@id`-tagged routes) — remove or rename the block on the Caddy host, reload, and hit **Retry**.
- **Reachability probe.** One HTTPS request is sent straight to the registered Caddy server's address on `:443`, with the TLS SNI and `Host` header set to the published domain — the equivalent of `curl --resolve`. Public DNS is deliberately not used: the record points at the WAN IP, and many homelab routers don't support NAT hairpinning, so a DNS-based probe would fail from inside the network for reasons unrelated to the site. The failure modes stay separate: a 502 is *your upstream* being down, an untrusted certificate is Let's Encrypt issuance still running, a refused connection is the Caddy host. Published sites are re-probed every `WEBSITE_RECONCILE_INTERVAL_MS`, so a site that breaks later drops to **warning** on its own and returns to **live** when it recovers.

### ⚠️ Route durability: admin-API routes are not persistent

Routes pushed through the Caddy admin API live **only in Caddy's running config**. The stock systemd unit

```
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
```

rebuilds the whole config from the Caddyfile on both `systemctl restart caddy` **and** `systemctl reload caddy` — including an unattended package upgrade of Caddy. Every route Homelabrrr pushed is dropped, with no error anywhere.

Two things mitigate this, and it is worth knowing which one you are relying on:

- **Reconcile loop (API mode, automatic).** Every `WEBSITE_RECONCILE_INTERVAL_MS` (default 5 min) Homelabrrr re-pushes any managed route missing from the live config, and the re-push is conflict-checked exactly like a publish. **Admin → Websites** shows a drift banner, and **Sync** runs it on demand. This means published sites come back by themselves — but there is a window between the reload and the next tick during which they are down.
- **Caddyfile snippet sync (SSH, durable).** Configure an SSH target on the Caddy server and Homelabrrr instead maintains `/etc/caddy/homelabrrr.caddy` on the Caddy host — imported once from the main Caddyfile with `import /etc/caddy/homelabrrr.caddy` — regenerating it on every publish/update/delete, running `caddy validate` (rolling back on failure), then `caddy reload`. The routes then live in a real file and survive restarts outright, so the reconcile loop skips these servers. This is the recommended mode for anything you care about.

Caddy's `--resume` flag is deliberately *not* used: it makes `autosave.json` the source of truth and causes legitimate Caddyfile edits to be silently ignored on restart, which trades one silent failure for another.

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

### Automatic deployment from GitHub Actions

The workflow in `.github/workflows/deploy.yml` deploys after a pull request is
merged into `main`. It can also be started manually from the Actions tab. A
dedicated self-hosted runner on the production server, labeled
`homelabrrr-production`, receives jobs over an outbound connection to GitHub;
the server does not need to expose SSH or another inbound management port.

The unprivileged runner account may only invoke the root-owned
`/usr/local/sbin/homelabrrr-deploy` command through `sudo`. That command refuses
to overwrite tracked local changes, pulls `origin/main` with `--ff-only`, and
runs `docker compose up -d --build`. Keep the production `.env` on the deployment
host; the workflow does not copy or replace it.

### Prerequisites

- Docker Engine with the Docker Compose plugin
- A Proxmox VE API token and network reachability from the backend container
- A DNS name and TLS-terminating reverse proxy for normal production use
- FortiGate, Caddy, Discord, and Proxmox host SSH access only when using the features that depend on them

### 1. Create your environment file

```bash
cp .env.example .env
```

Then set at least:

- `SESSION_SECRET` to a long random value, for example from `openssl rand -hex 32`
- `SECRET_ENCRYPTION_KEY` to a separate 32-byte base64, hex, or raw text key, for example from another `openssl rand -hex 32` invocation (used to encrypt secrets at rest)
- `ALLOWED_ORIGIN` to your public portal URL
- `COOKIE_SECURE` only if you need to opt out: session cookies are marked `Secure` by default, set `COOKIE_SECURE=false` only for plain-HTTP dev setups

Do not start with any `replace-with-...` or `change-this-...` placeholder still present.

If the database is brand new and empty, also set:

- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_PASSWORD`

Those bootstrap values are only used to create the first admin account on first run.
After the first successful sign-in, remove `INITIAL_ADMIN_PASSWORD` from `.env` and recreate the backend container so the bootstrap password is no longer present in its environment.

### 2. Build and start

```bash
docker compose up -d --build
```

The frontend is published on `http://localhost:8181` by default.
The liveness and readiness checks are available through the frontend proxy at `http://localhost:8181/api/health/live` and `http://localhost:8181/api/health/ready`. Container health uses readiness; liveness intentionally checks only that the process can answer HTTP.

That localhost URL is useful for a health check, but login cookies remain `Secure` in the production configuration. If you intentionally access the portal directly over plain HTTP for a local-only test, use `ALLOWED_ORIGIN=http://localhost:8181`, `COOKIE_SECURE=false`, and `TRUST_PROXY=1`; restore the production values before exposing it through a TLS proxy.

### 3. Put it behind a reverse proxy

Recommended model:

- TLS terminates at Nginx Proxy Manager or another reverse proxy
- the proxy forwards traffic to the frontend container
- the frontend nginx container proxies `/api/*` and websocket upgrades to the backend over the internal Docker network

By default, the frontend is published on port `8181` and bound to `127.0.0.1` (loopback only, matching `.env.example`).
Set `FRONTEND_BIND_ADDRESS=0.0.0.0` if the reverse proxy runs on another host and needs to reach the UI directly.

### 4. Counting your proxies (`TRUST_PROXY`)

`TRUST_PROXY` must equal the number of proxies between the client and the backend. Every proxy appends one
entry to `X-Forwarded-For`, and the backend walks back exactly `TRUST_PROXY` entries to decide who the client
is. Count each hop that touches the request — the bundled frontend nginx always counts as one:

| Topology | Hops | `TRUST_PROXY` |
| --- | --- | --- |
| clients → bundled nginx on `:8181` | nginx | `1` |
| clients → external reverse proxy (NPM, Caddy, Traefik) → bundled nginx | proxy + nginx | `2` *(recommended, the default)* |
| clients → Cloudflare → external reverse proxy → bundled nginx | CDN + proxy + nginx | `3` |
| a load balancer added in front of any of the above | +1 per extra proxy | add `1` |

Get it wrong and nothing visibly fails — but the portal records the proxy's address instead of the client's,
which makes the audit log's IP column useless and turns the per-account login lockout into a global one that
anyone can trip for everyone.

**Verify it:** sign in and open **Account → Connection**. It shows the address the portal sees for you, the
hop count that arrived, and whether it matches `TRUST_PROXY`. If the address shown is not your real public
IP, the value is wrong. The same data is available at `GET /api/health/client-ip` (requires authentication),
and the backend logs a one-time warning on startup traffic when the numbers disagree.
### 5. Configure encrypted, verified, off-host backups

Everything Homelabrrr knows lives in the PostgreSQL database inside the `pg_data` volume. `docker compose down` keeps that volume; `docker compose down -v` **deletes it**.

The backend can take an online `pg_dump --format=custom` snapshot, encrypt it with AES-256-GCM into a `homelabrrr-<stamp>.dump.enc` archive, copy it to a separate destination, and verify it by decrypting the copied artifact and reading its archive table of contents with `pg_restore --list`. No application downtime is required for the scheduled snapshot. (`pg_dump`/`pg_restore` come from the `postgresql17-client` package baked into the backend image.)

Set these before enabling backups:

```dotenv
BACKUP_ENCRYPTION_KEY=a-separate-random-secret-at-least-32-characters
BACKUP_RETENTION_DAYS=14
BACKUP_INTERVAL_MS=86400000

# Local staging; this may stay on the Docker host.
BACKUP_HOST_PATH=./backups

# Production: use a NAS/remote-filesystem mount or a directory continuously
# replicated to object storage. Do not leave this on the application host.
BACKUP_OFFSITE_HOST_PATH=/mnt/nas/homelabrrr
```

Keep `BACKUP_ENCRYPTION_KEY` in a password manager or secrets system separate from the database, staging directory, and off-host destination. Scheduled failure/success events use the existing configurable backup notification channels. **Admin → Operations** shows whether backups are configured, the last outcome/failure reason, size, and verified-restore time; it can also run one immediately.

#### Disaster-recovery restore

Restore is a two-step operation: `restore-backup` turns the encrypted archive back into a verified plain `pg_dump` custom-format file, and then `pg_restore` loads that file into a **new, empty database** — never over a live one.

1. Secure a copy of the encrypted `.dump.enc` artifact and the separate backup key.
2. Decrypt and verify it to a plain `.dump` file. The restore command refuses to overwrite an existing target and reads the archive's table of contents before reporting success.

   ```bash
   docker compose run --rm \
     -e BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" \
     backend npm run restore-backup -- \
     /app/backups-offsite/homelabrrr-YYYY-MM-DDTHH-MM-SS.dump.enc \
     /app/data/db-restored.dump
   ```

3. Create a fresh target database and load the verified archive into it with `pg_restore` (drop ownership so it re-owns to the connecting role). Do this against a **new** database, not the live one:

   ```bash
   # e.g. create homelabrrr_restored on the same server, then:
   pg_restore --no-owner --dbname="postgres://homelabrrr:$POSTGRES_PASSWORD@127.0.0.1:5432/homelabrrr_restored" \
     ./data/db-restored.dump
   ```

4. Point the backend at the restored database (set `DATABASE_URL` to it, or promote it to the primary name once verified), start the backend, then check readiness and sign in:

   ```bash
   docker compose up -d backend
   curl --fail http://127.0.0.1:8181/api/health/ready
   ```

Never discard the original database until users, upstream credentials, and a fresh backup have all been verified against the restored copy.

## Local Development

Docker Compose is the normal deployment path. For local frontend/backend development you need a reachable PostgreSQL — a throwaway one is a single command:

```bash
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine
```

Then start the backend (TypeScript runs directly — no build step):

```powershell
cd backend
npm install
$env:DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/postgres"
$env:SESSION_SECRET="dev-session-secret"
$env:SECRET_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"
$env:INITIAL_ADMIN_USERNAME="admin"
$env:INITIAL_ADMIN_PASSWORD="change-this-before-first-start"
npm run dev            # node --watch src/index.ts, backend on :3000
```

In another shell:

```powershell
cd frontend
npm install
npm run dev
```

Vite proxies `/api` and websocket traffic to `http://localhost:3000`.

## Tests and Build Checks

The repository has package-level lint/test/type-check/build scripts, Playwright coverage for route authorization, and a GitHub Actions workflow. The backend test suite (~620 tests via `node --test`) talks to a real PostgreSQL: set `TEST_DATABASE_URL` (default `postgres://postgres:postgres@127.0.0.1:5432/postgres`) and have a reachable server — the throwaway `docker run … postgres:17-alpine` from [Local Development](#local-development) is enough.

```bash
cd backend
npm ci
npm run lint
npm run typecheck               # strict type-check of the db layer
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test

cd ../frontend
npm ci
npm run lint
npm test
npm run build
npm run e2e
```

CI (`.github/workflows/ci.yml`) repeats those checks against a `postgres:17-alpine` service container and builds both production images on every pull request. The supported runtime is Node.js 26. Production Docker bases are deliberately pinned to `node:26.5.1-alpine3.24` and `nginx:1.31.3-alpine3.24`; Dependabot proposes reviewed updates for npm, Docker, and GitHub Actions dependencies.

## Environment

Example values live in [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string the backend uses. In Docker Compose it is assembled from `POSTGRES_*` and points at the bundled `postgres` service; set it directly to use an external database instead |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Database name, role, and password for the bundled `postgres` service; `docker-compose.yml` also reads them to build `DATABASE_URL` (a password is required) |
| `PG_POOL_SIZE` | Maximum connections in the backend's shared `pg` pool (default `10`) |
| `SESSION_SECRET` | Session signing secret |
| `SECRET_ENCRYPTION_KEY` | 32-byte master key for encrypting secrets at rest; accepted as base64, 64-char hex, or exactly 32 bytes of raw text |
| `SECRET_ENCRYPTION_KEY_ID` | Stable identifier embedded in new ciphertext (default `primary`); choose a new ID when rotating the key |
| `SECRET_ENCRYPTION_PREVIOUS_KEYS` | JSON object or comma-separated `id=key` keyring used only to decrypt and transactionally rotate legacy ciphertext |
| `ALLOWED_ORIGIN` | Exact public browser origin allowed for CORS and websocket upgrades |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | Passkey relying-party hostname and exact browser origin (normally derived from `ALLOWED_ORIGIN`) |
| `COOKIE_SECURE` | Marks auth cookies as `Secure` (default `true`; set to `false` only for plain-HTTP local dev) |
| `TRUST_PROXY` | Number of proxy hops in front of the backend (default `2`: external reverse proxy + bundled nginx; set `1` if clients reach port 8181 directly) — see [Counting your proxies](#4-counting-your-proxies-trust_proxy) |
| `ALLOW_INSECURE_UPSTREAM_TLS` | Break-glass override for self-signed Proxmox/FortiGate certs (default `false`) |
| `ALLOW_INTERNAL_IMAGE_URLS` | Allow cloud-image and ISO downloads from internal/reserved addresses, e.g. an internal mirror (default `false`) |
| `PORTAL_BASE_URL` | Absolute portal URL used for "open in portal" links in Discord embeds (falls back to `ALLOWED_ORIGIN`; links omitted if neither is set) |
| `NODE_HEALTH_POLL_MS` | Interval for the background Proxmox health monitor that emits node unreachable/recovered notifications (default `60000`; `0` disables it) |
| `INITIAL_ADMIN_USERNAME` | First admin username for empty DB bootstrap |
| `INITIAL_ADMIN_PASSWORD` | First admin password for empty DB bootstrap |
| `FRONTEND_BIND_ADDRESS` | Host bind address for frontend publishing (default `127.0.0.1`; set `0.0.0.0` to expose on all interfaces) |
| `LEASE_CHECK_INTERVAL_MS` | How often the background VM-lease sweeper runs to gracefully stop expired VMs (default `900000` = 15 min; minimum `60000`). Default lease duration and grace period are set in-app on the admin VM Leases page |
| `VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS` | How long a scheduled graceful shutdown waits before the hard-stop fallback fires (default `120000`) |
| `WEBSITE_RECONCILE_INTERVAL_MS` | How often published websites are re-checked: admin-API routes dropped by a `caddy reload` are re-pushed, and every published site is re-probed over HTTPS (default `300000` = 5 min; minimum `60000`) — see [Route durability](#️-route-durability-admin-api-routes-are-not-persistent) |
| `AUDIT_RETENTION_DAYS` / `JOB_RETENTION_DAYS` | Retention for audit records (default 365 days) and terminal job history (default 90 days) |
| `BACKUP_DIR` / `BACKUP_OFFSITE_DIR` / `BACKUP_ENCRYPTION_KEY` | Enables scheduled `pg_dump` custom-format, encrypted backups whose separately copied artifact is restore-verified (`pg_restore --list`); keep the backup key separate from the database and both destinations |
| `BACKUP_RETENTION_DAYS` / `BACKUP_INTERVAL_MS` | Backup retention (default 14 days) and schedule (default daily) |
| `BACKUP_HOST_PATH` / `BACKUP_OFFSITE_HOST_PATH` | Compose host mounts for local staging and the separately mounted/replicated disaster-recovery destination |
| `DB_PATH` | **Legacy** — path to the old SQLite file, used only by the one-time `import-sqlite` tool (see [Migrating from SQLite](#migrating-from-sqlite)). The running server no longer reads or writes it |

Every variable in this table is passed into the backend container by `docker-compose.yml`, and the backend logs which ones it recognised at startup (`docker compose logs backend | grep '\[config\]'`) — so a setting that is being ignored is visible rather than silent.

Useful implementation defaults:

- backend listens on port `3000` inside Docker
- frontend nginx listens on port `80` inside Docker and publishes host port `8181`
- PostgreSQL data is stored in the `pg_data` Docker volume; the old `db_data` volume is retained for one release only, as the SQLite import source / rollback artifact, and the running server no longer writes to it
- SFTP uploads stream directly to the guest without an application-level size cap; available space and limits on the remote host are the effective ceiling. Other API requests are capped by nginx at 105 MB

## Database Migrations, Retention, and Recovery

Schema changes ship as numbered SQL files in `backend/drizzle/`. Each is produced from the Drizzle schema with `npm run db:generate` (drizzle-kit) and then hand-trimmed — the generator's output is a draft, not gospel — and a small runner applies the unapplied files in order, inside one advisory-locked transaction, recording each in the `schema_migrations` table. Migrations run automatically at startup, before the server begins listening, so any migration failure stops the boot rather than serving on a half-applied schema. Never edit an already-applied migration; add a new numbered file. Take a verified backup before deploying a migration-bearing release and retain the pre-upgrade artifact through the validation window.

Incremental maintenance deletes at most 500 eligible rows per high-growth table per run (batch capped at 5000), then runs `ANALYZE` to refresh planner statistics — the PostgreSQL analogue of the old `PRAGMA optimize`. PostgreSQL's autovacuum reclaims dead-row space on its own, so there is no online `VACUUM` step. Defaults are 365 days for security audit history and 90 days for terminal provisioning, migration, backup-task, and workflow history; running/queued records are protected. Configure `AUDIT_RETENTION_DAYS` and `JOB_RETENTION_DAYS` to meet your policy. **Admin → Operations** reports database size, the reclaimable (dead-tuple) estimate, oldest retained records, and the last cleanup result. (PostgreSQL's WAL is cluster-global rather than per-database, so the panel's WAL figure is always `0`.)

## Migrating from SQLite

Homelabrrr stored its state in SQLite before this release. If you are upgrading an existing install, run this one-time operator runbook once to copy that database into PostgreSQL. The old `db_data` volume is left completely untouched throughout, so a rollback is always available.

1. Stop the backend so nothing writes to the old database while you copy it:

   ```bash
   docker compose stop backend
   ```

2. Bring up only PostgreSQL and wait for it to report healthy:

   ```bash
   docker compose up -d postgres
   docker compose ps postgres        # wait until STATUS shows (healthy)
   ```

3. Run the import tool from a **throwaway container** that mounts the old `db_data` volume read-only and installs the dev toolchain (the import path uses `better-sqlite3`, which builds natively there). Verify the actual volume and network names first with `docker volume ls` / `docker network ls` — Compose prefixes them with the project name:

   ```bash
   docker run --rm \
     -v <project>_db_data:/old:ro \
     -v $(pwd)/backend:/app -w /app \
     --network <project>_internal \
     node:26.5.1-alpine sh -c "apk add --no-cache python3 make g++ && npm ci && \
       node src/scripts/importSqlite.ts --source /old/db.sqlite \
       --target postgres://homelabrrr:$POSTGRES_PASSWORD@postgres:5432/homelabrrr"
   ```

   The tool copies every table in foreign-key order and translates the SQLite representation to PostgreSQL types along the way: `0`/`1` → real booleans, `TEXT` dates → `timestamptz`, the `''`-empty sentinel → `NULL`, JSON strings → `jsonb`, `BLOB` → `bytea`, and encrypted columns are copied **byte-for-byte** (so the `enc:v2:` envelopes still decrypt with your existing key). It refuses a non-empty target unless you pass `--force`, and it prints a per-table verification table at the end. If it reports orphaned rows (references the new foreign keys would reject), rerun with `--null-orphans` to import them with those references set to `NULL`.

   Flags: `--source`, `--target`, `--force`, `--include-sessions` (also copy the 24h-ephemeral `sessions` table, normally skipped), `--null-orphans`.

4. Check the verification table, then bring the app up on PostgreSQL and confirm it:

   ```bash
   docker compose up -d --build backend frontend
   curl --fail http://127.0.0.1:8181/api/health/ready
   ```

   Sign in and spot-check **Admin → Operations**.

5. **Rollback.** The `db_data` volume was never modified, so reverting is just checking out the pre-migration tag and rebuilding:

   ```bash
   git checkout <pre-migration tag>
   docker compose up -d --build
   ```

   Keep the `db_data` volume until you have taken and verified your first PostgreSQL backup.

## Encryption-Key Rotation Runbook

Encrypted values use `enc:v2:<key-id>:` envelopes. New writes use only `SECRET_ENCRYPTION_KEY_ID`/`SECRET_ENCRYPTION_KEY`; `SECRET_ENCRYPTION_PREVIOUS_KEYS` is a decryption-only JSON object (or comma-separated `id=key` list).

1. Create and verify an off-host database backup. Record the current key ID and keep its key outside the archive.
2. Generate a new 32-byte key, choose a new stable ID, set it as the current key, and put the old ID/key in `SECRET_ENCRYPTION_PREVIOUS_KEYS`.
3. Restart. Open **Admin → Operations** and inspect the dry-run counts. Do not rotate if any record is undecryptable.
4. Select **Rotate now**. Rotation is one database transaction: any bad record rolls every earlier update back. Confirm the remaining count is zero and exercise Proxmox, firewall, SSH, webhook, and 2FA integrations.
5. Keep the old key available through the rollback/backup-retention window. Then remove it from `SECRET_ENCRYPTION_PREVIOUS_KEYS`, restart, and verify readiness plus a new backup.

Rollback means restoring the pre-rotation backup and restoring its keyring, or temporarily re-adding the old key ID when rollback does not require a database restore. Never log, commit, or store key material beside the backup.

## Observability and Shutdown

- `/api/health/live` checks process viability only. `/api/health/ready` checks PostgreSQL connectivity and the applied schema version (it reads the highest `schema_migrations` version) without a destructive probe.
- Authenticated admins can read Prometheus text at `/api/metrics`: request totals/latency, upstream failures, job states, active VNC/SSH WebSockets, and PostgreSQL database size (`homelabrrr_pg_database_bytes`).
- Backend logs are structured JSON for request and lifecycle events, return `X-Request-Id`, and centrally redact credential-shaped fields. Long-running operation rows retain their originating request ID and actor.
- `SIGTERM`/`SIGINT` stop new HTTP and background-job admission, timers, schedulers, and website polling; close WebSockets with code 1001; give scheduler, backup, provisioning, ISO/image, template-build, and console-patch work a bounded 15-second drain; and close the PostgreSQL connection pool. A forced drain is recorded in the shutdown log, and any unfinished durable operation is reconciled on the next start.

An actionable baseline is to alert when readiness fails for two consecutive checks, any encrypted backup is unverified/failed, upstream failure counts rise continuously, `needs_review` jobs remain unresolved, or WAL size grows without returning after maintenance. Route backup failures to an operator-owned notification channel.

## Module Boundaries

HTTP route modules should authenticate/authorize, validate, call a domain service, and format the response. Database/upstream lifecycle logic belongs under `backend/src/services` or a focused utility, while shared error/redaction/audit behavior belongs in middleware/utilities. Large React pages should delegate independent stateful areas to components (for example account security/re-authentication) and use `navSections.js` as the single permission source for both links and route guards. Add behavior tests before moving an existing domain so refactors remain reviewable.

## Security Model

Current hardening in the codebase includes:

- no hardcoded default admin user on fresh install
- optional mandatory 2FA enrollment
- multiple named WebAuthn/passkey credentials, hashed single-use recovery codes, and user-visible active-session revocation; sensitive changes require recent password/TOTP confirmation
- 2FA lifecycle protection: starting a new enrollment cannot silently disable an active second factor, admin 2FA resets require confirmation, and setup/enable/disable/reset are audit-logged
- login and 2FA attempt throttling, with admin unlock support
- invite links are single-use and rate-limited like login; only a SHA-256 hash of the token is stored (the raw token is shown to the admin once), and redemption creates the account inside a single transaction that applies the preset and marks the invite consumed atomically
- personal API tokens are stored only as SHA-256 hashes (plaintext shown once), default to read-only scopes, resolve the live user on every request, are rate-limited on failure, cannot perform interactive identity/credential operations, do not extend to VNC/SSH websockets, and are attributed by token name in the audit log
- assignment-aware VM access (users only see their own VMs)
- backup browse, download, restore, and delete verify that the named backup volume actually belongs to the VM being operated on (the VMID embedded in the volid must match; unparseable volids are rejected)
- VM reach is split across two flags: **View all VMs** (`see_all_vms`) is strictly read-only — status, config, RRD graphs, backup listings — while **Operate all VMs** (`can_operate_all_vms`) is what grants power actions, snapshots, backups, VLAN/hardware edits, DHCP reservations, and VNC/SSH/SFTP console access across the fleet. Console + SSH on every VM is effectively root on the fleet, so it is a separate, deliberately-granted permission
- destructive operations that overwrite a VM's live state (VM deletion, backup restore, snapshot rollback, cloud-init credential reset, lease renewal, schedule edits) require strict VM ownership — neither fleet-wide flag grants them
- cloud-init credential resets require strict VM ownership too, are only offered for VMs that actually have a cloud-init drive, and never persist or log the new password/SSH key (only the reset event is audited)
- Proxmox node names are validated against a strict DNS-label pattern and URL-encoded before being interpolated into upstream API paths, so a crafted node name can't steer requests made with the privileged PVE API token (path injection / SSRF)
- non-admin SSH/SFTP targets are DNS-pinned and restricted to an address detected for the selected VM, explicitly assigned to it, or inside the user's assigned VLANs; ports are validated, attempts are durably rate-limited, and unusual admin overrides are explicit/audited
- SFTP access reuses the same authenticated SSH session setup and host-key checks as terminal access
- secrets encrypted at rest with a versioned current/legacy keyring and transactional dry-run rotation workflow
- upstream TLS enforcement for Proxmox and FortiGate connections (with explicit break-glass override)
- per-host Proxmox TLS verification settings
- granular permissions for delegated administration and fleet access
- user-scoped VLAN, policy, and port-forward management
- storage pool exposure is enforced server-side on every create path (clone, from-image, from-scratch), not just hidden in the UI — a non-admin naming a hidden pool directly is rejected; pools are exposed by default so existing setups are unchanged until an admin restricts one, and every toggle is audit-logged
- hardware editing is separately permission-gated and audit-logged
- broad audit logging for security and infrastructure actions with actor, target, IP, request ID, outcome, and timestamp; a global mutation event intentionally records denied/failed authenticated writes without recording bodies or secrets
- error message sanitization (strips internal IPs and paths from API responses)
- CORS/websocket origin checks tied to `ALLOWED_ORIGIN` or same-origin access, plus secure cookies and nginx security headers

Admin-assisted recovery policy: verify the person's identity outside the portal before resetting a password or TOTP requirement. Admin resets require recent re-authentication and are explicitly audited; after recovery, revoke exposed tokens/sessions, require TOTP re-enrollment when policy demands it, and have the user regenerate recovery codes. Passkeys are user-managed and should be removed only by the account owner after regaining access.

Operationally important:

- The frontend is plain HTTP inside Docker by design.
  Put TLS at the reverse proxy.
- The PostgreSQL data volume (`pg_data`) contains sensitive operational data, with upstream secrets encrypted at rest.
  Back it up and protect it — see [Configure encrypted, verified, off-host backups](#5-configure-encrypted-verified-off-host-backups).
- The backend image runs as the unprivileged `node` user (uid 1000) from PID 1; it no longer writes an on-disk database, so there is no root-owned db file to chown at startup.
- SSH private keys are stored encrypted in the application database for browser terminal access.
  Treat the DB as sensitive.

## Operational Constraints

- Run exactly **one backend replica**. Console/SFTP handoff tokens, VMID reservations, background-job locks, notification queues, and schedulers keep process-local state. Multiple replicas can lose console handoffs or perform the same scheduled work twice.
- Provisioning and migration rows persist their Proxmox UPID, actor, phase, and request ID. A restart moves every unfinished operation—with or without an upstream task ID—to `needs_review` in **Admin → Operations** instead of guessing that it failed. **Check upstream** records the observed task state without silently changing the portal resource, while **Remove tracking only** is available only after a terminal result and never deletes the Proxmox guest. Verify the resource in Proxmox before resolving, retrying, or removing tracking. ISO/image-specific pollers still require operator review after interruption.
- Keep PostgreSQL on the local `pg_data` volume; this deployment is not designed for horizontally scaled backend writers (the single-replica constraint above is what matters — in-process schedulers, locks, and console-handoff maps assume one backend). Scheduled backups use an online `pg_dump`, so no downtime is needed for them.

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

- the PostgreSQL data volume
- saved credentials inside the DB
- firewall changes already pushed to FortiGate
- Proxmox-side changes already applied

If you want safe rollback in practice, pair Git with database backups and network config backups.
See [Configure encrypted, verified, off-host backups](#5-configure-encrypted-verified-off-host-backups) for the database half.

## Changelog

Recent changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).
Signed-in users can also open the changelog directly from the sidebar in the UI.
