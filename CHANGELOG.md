# Changelog

## 2026-03-23 — Scoped VLAN management for delegated users

### Automatic CPU topology matching
- VMs are now created with 2 sockets and cores spread evenly across them, matching the physical host's socket layout
- The max cores per socket is capped at the host's actual cores-per-socket (fetched from `/nodes/{node}/status` at provision time)
- This is fully transparent — users/admins still just pick a total core count, and the backend computes the optimal `sockets × cores` split
- Example: requesting 8 cores on a 2×12 host → VM gets `sockets=2, cores=4`
- Applies to both clone and create-from-scratch provisioning

### VLAN picker in VM provisioning
- Both clone and create-from-scratch forms now include a VLAN dropdown so the VM's network can be tagged at creation time
- Admins see all VLANs; non-admin users only see VLANs assigned to them via `user_vlans`
- Backend validates non-admin VLAN access before applying the tag
- Clone applies the VLAN tag after the post-clone configuration step; create sets it directly on `net0`

### VLAN ownership enforcement
- Non-admin users with `can_manage_vlans` can now only see and manage VLANs assigned to them via `user_vlans`, matching the existing policy-manager scoping model
- All VLAN mutation routes (edit, delete, sync, unsync) now verify the non-admin user owns the VLAN before proceeding
- New VLANs created by non-admin users are automatically assigned to the creating user so they can immediately manage them
- Non-admin users still cannot pick a VLAN tag (auto-assigned from the next available in firewall pools) or create tagged-only VLANs

### Frontend fixes
- VLANs page no longer fails for non-admin VLAN managers who lack `can_manage_firewalls` — firewall ranges are extracted from the VLAN response as a fallback
- Empty state messaging is now role-aware

## 2026-03-22 — Performance, provisioning, and SSH improvements

### API response caching
- `getAllVMs()` now has a 5-second TTL cache so concurrent/frequent polls from multiple browser tabs don't hammer the Proxmox API on every request
- VM detail page now fetches only the single VM it needs (`/vms/:node/:vmid/status`) instead of the entire VM list, reducing backend load and improving page responsiveness

### Provisioning assignment fix
- Admin users no longer get auto-assigned to VMs they create or clone — admins already see all VMs, and the spurious assignment (combined with the one-user-per-VM unique constraint) was blocking subsequent assignment to the intended user
- Clone form now includes an "Assign to User" dropdown for admins, matching the create form
- Both forms default to "No assignment" for admins with a hint that admins see all VMs without one

### SSH fingerprint scanner cleanup
- Host key fingerprint scanning no longer sends fake credentials to the target server — it rejects the host key immediately after capturing the fingerprint, so no authentication attempt reaches the server's auth log

## 2026-03-20 — Secrets-at-rest and upstream trust hardening

### Encrypted secret storage
- Sensitive values stored in SQLite are now encrypted at rest with an application master key instead of being left in plaintext
- This covers stored SSH private keys, Proxmox API token secrets, FortiGate API keys, and TOTP secrets
- Existing plaintext values are migrated in place automatically on startup once `SECRET_ENCRYPTION_KEY` is configured

### Upstream TLS enforcement
- Proxmox and FortiGate management connections now reject saved records with TLS verification disabled unless an explicit break-glass override is enabled
- New host and firewall records still default to TLS verification enabled, and admin forms now block disabling it unless `ALLOW_INSECURE_UPSTREAM_TLS=true` is set
- Legacy Proxmox host records created before the secure-default change are migrated toward verified TLS by default

### Console websocket tightening
- Browser VNC and SSH console tokens are no longer sent in URL query strings during normal operation
- Console websocket authentication now uses websocket subprotocols, keeping tokens out of common URL logging paths while preserving the existing single-use/session-bound checks

### Permission and inventory scoping
- Full manual VM creation is now admin-only; delegated users can continue using the template provisioning flow without getting unrestricted infrastructure placement controls
- Delegated VLAN and policy managers no longer receive full firewall management-plane inventory details when loading the shared firewall list

### Deployment note
- Deployments now require `SECRET_ENCRYPTION_KEY` to be set for the backend to start
- `ALLOW_INSECURE_UPSTREAM_TLS` is available as a temporary exception for environments that still depend on self-signed or otherwise untrusted upstream management certificates

## 2026-03-14 — Port forwarding stabilization

### Page load fix
- Fixed the port forwarding page API calls so they use the shared frontend API client correctly instead of requesting `/api/api/...`
- This resolves the immediate `Failed to load firewalls` error on the new port forwarding page

### Exact per-forward policy services
- Managed port forwards no longer create broad root-VDOM policies using `ALL_TCP` or `ALL_UDP`
- Each UI-created port forward now creates or uses a dedicated custom FortiGate service object tied to that specific forwarded port and protocol
- The root-VDOM firewall policy for a managed port forward now references that exact service object, making the rule explicit and easier to audit
- Managed port forward cleanup now removes the associated custom service object along with the VIP and policy

## 2026-03-14 — Port Forwarding / WAN VIP management (WIP)

### Port forwarding admin page
- New admin page at `/admin/port-forwarding` for managing FortiGate VIPs (port forwards) on the root VDOM
- Displays all existing VIPs from the FortiGate with managed/external badges — external (pre-existing) VIPs are read-only, managed ones can be deleted
- Create form with live port conflict checking: warns immediately if an external port + protocol combo is already in use by another VIP
- Source address restriction dropdown populated from root VDOM address objects and groups
- Destination zone dropdown populated from root VDOM interfaces (filtered to exclude WAN, tunnel, loopback, management)

### Backend: FortiGate VIP API
- Added VIP CRUD methods to `fortigate.js`: `getVips()`, `getVip()`, `createVip()`, `deleteVip()` — all accept `vdomOverride` for cross-VDOM access
- Added `getAddressGroups()` for source restriction dropdown
- Updated `getInterfaces()` and `getAddressObjects()` to accept optional `vdomOverride` parameter
- New admin routes: `GET/POST/DELETE /admin/firewalls/:id/vips`, `GET /admin/firewalls/:id/root-interfaces`, `GET /admin/firewalls/:id/root-addresses`
- `PUT /admin/firewalls/:id/wan-config` for setting external IP and WAN zone from the port forwarding page

### Backend: VIP creation flow
- Creates VIP in root VDOM with port forwarding enabled (extip → mappedip:mappedport)
- Auto-creates matching firewall policy in root VDOM (srcintf=WAN zone, dstintf=selected destination zone, dstaddr=VIP)
- Validates against all existing VIPs for port+protocol conflicts before creation
- Rolls back VIP if policy creation fails
- Tracks managed VIPs in `managed_vips` DB table for safe deletion (policy + VIP cleanup)

### Database changes
- New `managed_vips` table: tracks VIPs created through the UI with their associated policy IDs for cleanup
- New `firewalls` columns: `external_ip` (public IP for VIPs), `root_wan_zone` (WAN interface name in root VDOM, default 'underlay')
- Firewall CRUD routes updated to read/write the new fields

### Frontend wiring
- New `PortForwardingPage.jsx` component with firewall selector, WAN config panel, VIP table, and create form
- Sidebar link under Networking section (requires `canManageFirewalls` permission)
- Route added at `/admin/port-forwarding`

### Status: WIP
- Core implementation complete but not yet tested end-to-end against live FortiGate
- Needs debugging in next session — page loads but functionality not verified against the API yet

## 2026-03-12 — VM SSH config panel fix

### Inline SSH config updates
- Fixed the VM page and VM detail modal SSH save panels so they now load and submit the pinned SSH host fingerprint required by the hardened backend
- Added fingerprint scanning directly in those inline SSH config panels, not just the dedicated SSH modal
- Save errors now surface in the panel instead of failing silently when the SSH fingerprint is missing or invalid

## 2026-03-12 — Tagged-only VLANs for custom prod networks

### Flexible VLAN modes
- Added a tagged-only VLAN mode for admin-created VLANs that stay local to the portal and are never pushed to FortiGate
- Tagged-only VLANs support arbitrary VLAN IDs like `11`, `12`, and `13` instead of being tied to the lab firewall pool ranges
- Tagged-only VLANs now store and display a custom subnet CIDR instead of forcing the derived `10.xx.xx.0/24` lab subnet scheme

### VLAN UI and guardrails
- The VLAN modal now lets admins choose between managed VLANs and tagged-only VLANs with mode-specific guidance
- Tagged-only VLANs now show clearly in the VLAN list and no longer offer firewall sync actions
- Non-admin VLAN managers remain restricted to managed VLAN creation with the next available pooled tag assigned automatically by the backend

## 2026-03-12 — Admin-only manual VLAN tag selection

### VLAN creation permissions
- Non-admin users with VLAN management permissions can no longer choose arbitrary VLAN tags
- The backend now assigns the next available tag from the configured firewall pools for non-admin VLAN creation
- Only admins can manually choose a specific VLAN tag or change an existing VLAN tag
- The VLAN modal now shows auto-assigned tag behavior clearly for non-admin users

## 2026-03-12 — Safer VLAN deletion cleanup

### VLAN delete behavior
- Deleting a VLAN now keeps the VLAN in the portal if cleanup fails on any synced firewall
- Successful firewall deprovision steps now remove their sync record immediately, while failed firewalls remain attached for retry
- This prevents the app from dropping the VLAN locally while referenced firewall policies or interfaces still exist remotely

## 2026-03-12 — VLAN tag autofill from firewall ranges

### VLAN creation workflow
- The `New VLAN` modal now pre-populates the tag field with the next available VLAN tag from the configured firewall ranges
- If no firewall ranges exist, the form falls back to the first free tag in the default recommended range
- Added inline messaging so it is clear when the suggested tag came from the firewall pool or when no free pooled tags remain

## 2026-03-12 — TLS defaults and SSH host verification

### Secure-by-default management transport
- New Proxmox and FortiGate entries now default to TLS certificate verification enabled
- Existing saved hosts and firewalls keep their current `verify_tls` values during update instead of silently falling back to disabled
- Fresh databases now create firewall and PVE host records with secure TLS defaults

### SSH host key pinning
- VM SSH configs now store a pinned SSH host fingerprint alongside host and port
- Browser SSH access now refuses to connect unless a fingerprint is configured for the VM
- Added SSH fingerprint scanning to the SSH modal so users can fetch and save the presented host key before connecting
- Backend SSH connections now verify the presented host key against the stored fingerprint and reject mismatches

## 2026-03-12 — Authentication and websocket hardening

### Session and 2FA protection
- Login and 2FA completion now regenerate the session ID before elevating the session, reducing session fixation risk
- Added dedicated failed-attempt tracking for `/auth/verify-2fa` with lockout behavior after repeated invalid TOTP codes
- Added extra rate limiting on 2FA verification attempts

### Websocket token tightening
- VNC and SSH websocket upgrades now validate the browser `Origin` before accepting the connection
- Console websocket tokens are now bound to the authenticated session that created them
- VNC and SSH tokens are now single-use during websocket upgrade instead of remaining replayable after first connect

### Proxy and audit trust cleanup
- Audit logging now relies on Express-resolved client IPs instead of manually trusting raw `X-Forwarded-For`
- Added configurable `TRUST_PROXY` runtime support so reverse-proxy hop trust is not hardcoded in the backend

## 2026-03-11 — README polish for GitHub

### Repository presentation
- Added a proper root `README.md` for the project
- Reworked the documentation into a more GitHub-friendly landing page with a stronger intro, badges, highlights, and clearer section structure

### Setup and operations docs
- Documented the reverse-proxy deployment model more clearly
- Added cleaner quick-start, environment, security, and rollback guidance so the repo is easier to understand when landing on it for the first time

## 2026-03-11 — Admin changelog viewer

### Admin sidebar access
- Added a compact admin-only `Changelog` button in the bottom-left sidebar area above logout
- Clicking it opens a centered release-notes modal without being constrained by the sidebar layout

### Single source of truth
- The admin changelog UI now reads directly from the root `CHANGELOG.md` file
- New changelog entries automatically appear in the UI after rebuild/redeploy without maintaining a separate frontend data file

## 2026-03-11 — Policy mesh redesign and flow visualization

### Policy mesh redesign
- Reworked the Networking > Policies UI from a tile-and-pipe view into a relationship mesh
- Selecting a source VLAN now pulls it into the center, brings directly connected VLANs inward, and leaves other VLANs on an outer ring as available targets
- Policy paths now use multi-color gradients based on the services allowed on that policy, making mixed-service rules easier to read at a glance
- Added right-side guidance panels so the page explains what the mesh is showing without needing prior context

### Rule creation clarity
- The policy modal now includes a plain-English preview of exactly what will be created before submitting
- Added service-aware summaries and a rule count preview so one-way vs bidirectional policy creation is clearer

### Mesh animation and readability
- Node movement now animates through live position updates, so connection paths redraw continuously while VLANs move
- Restored directional traffic visualization with animated flow packets and moving current lines along allowed paths
- VLAN nodes were reshaped into square cards with an opaque inner panel so route lines do not bleed through the content area
- Node labels and badges were tightened to keep VLAN names, route counts, peer counts, and status chips readable inside the card body

## 2026-03-11 — Security hardening for internet exposure

### SSH access bound to assigned VMs
- `GET/PUT /ssh/config/:node/:vmid` and `POST /ssh/connect` now enforce the same VM access rules as the VM/VNC routes
- SSH connections no longer accept arbitrary host/port/user targets from the client
- The backend now resolves the SSH destination from the stored VM SSH config after authorization, preventing authenticated users from using the portal as a generic SSH pivot into the internal network

### Real 2FA enforcement
- Users with `require_2fa = 1` but no enrolled TOTP no longer receive a full unrestricted session after password login
- These users now receive a restricted session that only allows account management, password change, 2FA setup, and logout until 2FA is enabled
- Self-service 2FA disable is blocked when an account is configured to require 2FA

### Bootstrap and privilege hardening
- Removed the hardcoded `admin / admin` first-run bootstrap account
- Empty databases now require `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` to create the first admin account
- Non-admin users with `can_manage_users` can no longer create admin accounts, grant granular permissions, or modify existing admin accounts

### Policy object hardening
- Firewall address/service object management routes are now admin-only
- Delegated policy managers remain scoped to policy creation/deletion for their assigned VLANs, but can no longer modify firewall-global objects

### Deployment defaults
- Removed global `NODE_TLS_REJECT_UNAUTHORIZED=0`
- Frontend bind address now defaults to `127.0.0.1` in Compose so the app does not bypass the reverse proxy by default
- `COOKIE_SECURE` now defaults to `true` in Compose for TLS-terminated deployments
- Proxmox TLS verification is now configurable per host instead of hardcoded off globally

## 2026-03-10 — VLAN-scoped access for non-admin policy managers

### VLAN scoping for delegated users
- Non-admin users with `can_manage_policies` (or `can_manage_vlans`, `can_manage_assignments`) now only see VLANs assigned to them via `user_vlans` — admins continue to see all VLANs
- `GET /admin/vlans` filters results through `user_vlans` join for non-admins
- `GET /admin/policies` only returns policies involving the user's assigned VLANs (syncs query joins through `user_vlans`)
- `POST /admin/policies` validates non-admins have both source and destination VLANs assigned before creating a policy
- `DELETE /admin/policies/:policyId` fetches the policy from FortiGate, checks its interfaces against the user's assigned VLAN interfaces, and blocks deletion if no match
- New `getPolicy(policyId)` method on `FortiGateAPI` class for single-policy lookup

### Workflow for delegated policy management
1. Admin assigns VLANs to a user on the "VLAN Access" tab in user management
2. Admin grants `can_manage_policies` permission on the "Permissions" tab
3. User opens Policy Engine — only sees VLAN cards for their assigned VLANs
4. User can create/delete policies only between their own VLANs

### Files modified
- `backend/src/routes/admin.js` — VLAN/policy GET endpoints filter by `user_vlans` for non-admins, policy create/delete validates VLAN access
- `backend/src/fortigate.js` — `getPolicy()` method for single policy fetch

---

## 2026-03-10 — Granular permissions system

### Per-feature permission flags
- Replaced the binary admin/user model with granular permission flags that can be toggled per-user
- `isAdmin` remains as superadmin — bypasses all permission checks and has full access
- New permission columns on users table:
  - `can_manage_hosts` — PVE host CRUD
  - `can_manage_firewalls` — Firewall CRUD, switch discovery
  - `can_manage_vlans` — VLAN CRUD, firewall sync/deprovision
  - `can_manage_policies` — Policy engine, address/service objects
  - `can_manage_templates` — VM template CRUD
  - `can_manage_users` — User CRUD, permission management
  - `can_manage_assignments` — VM/VLAN assignment management
  - `can_view_audit_log` — Read-only audit log access
- Existing flags (`can_provision`, `see_all_vms`) remain unchanged

### Backend permission middleware
- New `requirePermission(...columns)` middleware factory in `backend/src/middleware/auth.js`
- Checks: admin bypasses all, otherwise user must have at least one of the listed permission columns set to 1
- Every admin route now has per-route permission middleware instead of blanket `requireAdmin`
- Cross-feature read access: VLANs/firewalls GET endpoints also allow `can_manage_policies` and `can_manage_assignments` users (needed by policies and assignments pages)
- New endpoint `PUT /admin/users/:id/permission` — toggle any granular permission flag

### Frontend permission-aware UI
- `/auth/me` now returns `permissions` object with all 8 flags
- `AdminRoute` component allows access if user has any management permission (not just isAdmin)
- `AdminIndexRedirect` sends users to the first admin page they have access to
- Sidebar navigation shows only sections/links the user has permission for
- Each section (Infrastructure, Networking, Access) only appears if the user has at least one permission in that group

### User management — Permissions tab
- New "Permissions" tab in the ManageUserModal (default tab)
- Visual toggle switches for every permission: VM Access (see all VMs, provision), Admin Features (8 granular permissions), Security (enforce 2FA)
- Admin users show an info banner ("Admins bypass all permission checks")
- User table now shows a "Permissions" column: "Full access" for admins, "N granted" count for users, "None" for users with no permissions
- Permission toggles removed from Account tab (moved to Permissions tab)
- VMs tab shows info banner when "Access all VMs" is enabled (points to Permissions tab)

### Provision routes updated
- Template admin endpoints (`/provision/admin/templates/*`) now use `requirePermission('can_manage_templates')` instead of `requireAdmin`

### Files modified
- `backend/src/db.js` — 8 new permission column migrations
- `backend/src/middleware/auth.js` — `requirePermission()` factory, DB import
- `backend/src/routes/admin.js` — per-route permission middleware on all routes, new `/users/:id/permission` endpoint, users GET returns all permission fields
- `backend/src/routes/auth.js` — `/me` returns permissions object
- `backend/src/routes/provision.js` — template admin routes use `requirePermission`
- `frontend/src/contexts/AuthContext.jsx` — permissions passed through (no code change needed, data flows through)
- `frontend/src/components/Layout.jsx` — permission-aware sidebar rendering
- `frontend/src/App.jsx` — `AdminRoute` allows any permission, `AdminIndexRedirect` component
- `frontend/src/pages/admin/UsersPage.jsx` — Permissions tab, `PermToggle` component, permission count column

---

## 2026-03-10 — Policy Engine, sidebar reorganization, VLAN provisioning fixes

### Policy Engine (visual firewall policy builder)
- New admin page at `/admin/policies` — visual click-to-connect VLAN policy creation
- VLAN cards displayed in a grid; click source, then destination to create a policy
- SVG bezier connection lines between VLAN cards showing active policies with animated "pipe flow" effect — dashes flow along the path to visualize traffic direction
- Service picker modal: ALL, HTTP, HTTPS, SSH, RDP, DNS, PING, ALL_TCP, ALL_UDP
- Bidirectional toggle: creates policies in both directions
- Policies grouped by source interface in bottom panel with inline delete
- Backend endpoints: `GET/POST /admin/policies`, `DELETE /admin/policies/:policyId`
- Policies created on FortiGate with `global-label` grouping for sequence organization

### Address & Service Objects panel
- New tabs in Policy Engine bottom panel: Address Objects, Service Objects
- Lists all firewall address/service objects from FortiGate with inline delete
- Inline create forms for both object types
- Backend endpoints: `GET/POST/DELETE /admin/objects/addresses`, `GET/POST/DELETE /admin/objects/services`

### Admin sidebar reorganization
- Grouped admin navigation into logical sections: Infrastructure, Networking, Access
- Infrastructure: PVE Hosts, Firewalls, Templates
- Networking: VLANs, Policies, Assignments
- Access: Users, Audit Log
- New `NavSection` component for section headers

### Animated connection lines (pipe flow style)
- Policy connection lines now render as multi-layer SVG paths: dim background pipe, outer glow, animated flowing dashes, and a bright inner core
- Dashes animate along the path direction using SVG `<animate>` on `stroke-dashoffset`
- Animation speed scales with line length for consistent visual feel
- Green for accept policies, red for deny policies

---

## 2026-03-10 — FortiGate VLAN provisioning fixes (switch port + address objects)

### Root cause: tagged VLAN traffic not reaching FortiGate
- Discovered that the `PVE02-TRUNK` LAG (ports 41-43) connecting the Proxmox hypervisor to the FortiSwitch had `allowed-vlans "quarantine"` — only the quarantine VLAN was permitted as tagged traffic
- The `allowed-vlans-all` flag does not apply to VLANs assigned to a non-root VDOM (e.g. lab), so even ports with `allowed-vlans-all enable` (ports 49-51) won't automatically pass lab VDOM VLANs
- VMs sending tagged frames (e.g. VLAN 1004) were being dropped at the switch before reaching the FortiGate
- Internet policy path (lab VDOM → VDOM link → root VDOM → WAN with NAT) was confirmed correct — the issue was purely at the switch layer

### Trunk switch port auto-configuration
- VLAN provisioning now adds the new VLAN interface to the configured switch port's `allowed-vlans` list
- VLAN deprovisioning removes it from `allowed-vlans`
- New `removeManagedSwitchPortVlan()` method on `FortiGateAPI` class
- Configurable per-firewall: switch serial + port name stored in `firewalls` table (`trunk_switch_serial`, `trunk_switch_port`)

### Managed switch discovery UI
- New backend endpoint `GET /admin/firewalls/:id/switches` — fetches managed switches and their ports live from the FortiGate
- Firewall edit form now shows dropdown selectors for switch and port instead of free-text inputs
- Switch dropdown shows switch name and serial number
- Port dropdown shows port name, native VLAN, and `[LAG: members]` for trunk aggregates
- Refresh button to re-fetch switch data; falls back to text input for unsaved firewalls

### Address objects in firewall policies
- Provisioning now creates a firewall address object `NET-{network}_24` (e.g. `NET-10.10.4.0_24`) for each VLAN subnet
- The internet policy uses this address object as `srcaddr` instead of `all`, for proper source scoping
- New `getAddressObject()` method for idempotent existence checks
- Deprovisioning deletes the address object after removing referencing policies

### Provisioning step order (updated)
1. VLAN interface at global scope, assigned to lab VDOM, `allowaccess ping` enabled
2. Address object `NET-x.x.x.0_24` in lab VDOM
3. Firewall policy: srcintf=vlan, dstintf=lab-root0, srcaddr=address object
4. Static route in root VDOM
5. DHCP server (optional)
6. Add VLAN to trunk switch port's allowed-vlans
7. Switch-controller VLAN registration in root

### Database schema additions
- `firewalls.trunk_switch_serial` — managed switch name/serial for the hypervisor trunk port
- `firewalls.trunk_switch_port` — port name on the managed switch (e.g. `port49`)

### Interface ping access
- VLAN interfaces now created with `allowaccess: ping` so the gateway IP is pingable from VMs (useful for troubleshooting connectivity)

### Deprovision robustness
- Address object deletion now checks existence first and treats failures as warnings instead of errors
- Handles VLANs provisioned before address objects were added (no address object to delete)

### FortiGate API gotcha: managed-switch field names
- Switch identifier is `switch-id`, not `name` (which is undefined in API responses)
- Port identifier is `port-name`

### Files modified
- `backend/src/fortigate.js` — `getAddressObject()`, `removeManagedSwitchPortVlan()`, address object in provision/deprovision, switch port in provision/deprovision
- `backend/src/routes/admin.js` — `/firewalls/:id/switches` endpoint, trunk fields in firewall CRUD, trunk opts passed to provision/deprovision
- `backend/src/db.js` — `trunk_switch_serial` and `trunk_switch_port` column migrations
- `frontend/src/pages/admin/FirewallsPage.jsx` — switch/port dropdown selectors with live discovery

---

## 2026-03-09 — FortiGate switch-controller discovery

### Switch-controller VLAN registration
- Discovered that FortiLink **automatically creates internal switch-controller VLAN entries** when a VLAN interface is created under the `fortilink` parent interface
- These implicit entries do NOT appear in `GET cmdb/switch-controller/vlan` responses, but the switch controller tracks them internally
- Attempting to create an explicit entry via `POST cmdb/switch-controller/vlan` returns `-15 duplicate switch-vlan interface` for these auto-created entries
- Provisioning step 5 now attempts to create the entry, treats `-15`/`duplicate` as success (confirms FortiLink is already tracking the VLAN), and logs a warning for any other error
- This means no manual switch-controller registration is needed — FortiLink handles it when the interface parent is `fortilink`

### FortiGate API helpers added
- `getSwitchControllerVlans(vdomOverride)` — list all switch-controller VLAN entries
- `getSwitchControllerVlan(name, vdomOverride)` — get a specific entry by name
- `createSwitchControllerVlan(name, vlanId, description, vdomOverride)` — create explicit entry
- `deleteSwitchControllerVlan(name, vdomOverride)` — remove entry

### Files modified
- `backend/src/fortigate.js` — switch-controller VLAN getter/create/delete methods, provisioning step 5 handles duplicate gracefully

---

## 2026-03-09 — FortiGate Guide v2, VNC Fix

### FortiGate provisioning rewrite (updated guide)
- **Interface creation** now uses `scope=global` (`?global=1` API parameter) with `vdom` set in body to assign to lab VDOM
- Interface `role` changed from `'lan'` to `'undefined'` per FortiGate guide
- Removed `allowaccess: 'ping'` and `device-identification: 'enable'` from interface creation
- **Removed address object** (`NET-x.x.x.x_24`) from provisioning — not in updated guide
- **Removed switch-controller/vlan** entries from provisioning — replaced by managed-switch approach
- **Interface deletion** now also uses global scope for consistency
- Deprovision updated to match: no more address object or switch-controller/vlan cleanup
- Reordered provisioning steps: interface → policy → static route → DHCP (optional)

### FortiGate managed-switch support (new)
- Added `getManagedSwitches(vdomOverride)` — list all managed FortiSwitches in root VDOM
- Added `getManagedSwitch(serial, vdomOverride)` — get specific switch by serial
- Added `updateManagedSwitchPort(serial, portName, vlanName, trunk, vdomOverride)` — update a port's VLAN config (access or trunk mode, sets `export-to: root`)
- These are helper methods for future per-port VLAN assignment UI; not wired into auto-provisioning since switch/port selection is deployment-specific

### Sequence grouping fix
- Per-VLAN `global-label` on firewall policies (e.g. `"TestNet (vlan1126)"`) creates individual sequence groups in FortiGate GUI
- Each VLAN gets its own group so future VLAN-to-VLAN policies can be placed alongside

### Static route fix
- Fixed `seq-num` property access — FortiGate API returns hyphenated field names (`seq-num`), code was using underscore (`seq_num`)
- Both provision (existing route detection) and deprovision (route deletion) now use `match['seq-num'] || match.seq_num` for compatibility

### VNC blank screen fix
- Added `forceFullRefresh()` — sends a non-incremental `FramebufferUpdateRequest` to the VNC server via noVNC internal API (`_sendFramebufferUpdateRequest`)
- Auto-triggers 500ms after `connect` event to handle cases where the canvas wasn't properly sized when the initial full framebuffer arrived (modal animation, flex layout not settled)
- Added **Refresh** button to both VNC modal and full-page VNC toolbars for manual re-fetch
- Fallback: if internal API unavailable, dispatches resize event on the container element

### Files modified
- `backend/src/fortigate.js` — Full rewrite: global scope for interfaces, removed address object/switch-controller/vlan steps, added managed-switch helpers, fixed seq-num property access
- `frontend/src/components/VNCModal.jsx` — forceFullRefresh on connect + Refresh button
- `frontend/src/pages/VNCPage.jsx` — forceFullRefresh on connect + Refresh button

---

## 2026-03-09 — FortiGate Firewall Integration

### FortiGate firewall management (admin)
- New admin page `/admin/firewalls` to add, edit, and delete FortiGate firewalls
- Card-based layout matching PVE Hosts style with orange accent
- Per-firewall configuration: name, host, port, API key, lab VDOM, parent interface (FortiLink), WAN interface, VLAN ID range, VDOM link interfaces, route gateway, TLS verification
- Live status check showing FortiOS version, serial number, active VDOM, and synced VLAN count
- Firewalls stored in `firewalls` table in SQLite
- Nav link added with shield icon in admin sidebar

### FortiGate VLAN provisioning (6-step)
- Creating a VLAN with a firewall selected auto-provisions it on the FortiGate:
  1. VLAN interface in lab VDOM (parent: FortiLink, IP: gateway of /24 subnet)
  2. Address object `NET-{gateway_ip}_24` (e.g. `NET-10.11.26.1_24`)
  3. Firewall policy: vlan interface → lab VDOM link (`lab-root0`), log all traffic
  4. DHCP server on the VLAN interface with full /24 pool (excludes gateway)
  5. Static route in root VDOM: subnet via `lab-root1` with gateway `10.255.254.2`
  6. Switch-controller VLAN entry (sequence grouping for FortiLink managed switches)
- IP scheme: VLAN tag `1XXX` → `10.XX.XX.0/24` (e.g. VLAN 1126 → 10.11.26.0/24)
- Internet access and DHCP are individually toggleable per sync operation
- All provisioning steps are idempotent (check existence before creating — handles partial failures gracefully)

### VLAN range restriction per firewall
- Each firewall has a configurable VLAN ID range (default 1001–1999)
- Sync is blocked with a clear error if VLAN tag falls outside the allowed range
- VLANs page shows in-range/out-of-range status per firewall in sync modal

### FortiGate VLAN cleanup on delete
- Deleting a VLAN first deprovisions it from all synced firewalls:
  - Queries FortiGate live for all policies and DHCP servers referencing the interface (not just stored IDs)
  - Removes: firewall policies, DHCP server, static route (root VDOM), VLAN interface, address object, switch-controller VLAN entry
- VLAN is removed from the database regardless of cleanup outcome
- Partial failures are surfaced with details so admins know what may remain on the firewall

### VLANs page enhancements
- Table now shows Subnet column (e.g. 10.11.26.0/24) and Firewall sync status column
- Subnet preview shown live in create/edit form based on VLAN tag input
- Firewall sync checkboxes in create form with in-range validation and internet/DHCP toggles
- SyncModal for managing per-firewall sync state on existing VLANs
- Sync errors surfaced in the UI (modal stays open on failure, shows FortiGate error message)
- Delete confirmation lists firewall names that will be cleaned up

### Audit log action filter fix
- Backend `GET /admin/audit-log` now correctly filters by the `action` query parameter
- Both the count query and the rows query use the `WHERE action = ?` clause when filtering
- Frontend action filter dropdown updated with new firewall audit actions

### New audit log action types
- `admin_create_firewall` — firewall added
- `admin_update_firewall` — firewall edited
- `admin_delete_firewall` — firewall removed
- `admin_sync_vlan_firewall` — VLAN provisioned on firewall
- `admin_unsync_vlan_firewall` — VLAN deprovisioned from firewall
- `admin_delete_vlan` — VLAN deleted (with firewall cleanup details)

### Database schema additions
- `firewalls` table: id, name, type, host, port, api_key, vdom, parent_interface, wan_interface, vlan_range_start, vlan_range_end, lab_vdom_link, root_vdom, root_vdom_link, route_gateway, verify_tls, created_at
- `firewall_vlan_sync` table: id, firewall_id, vlan_id, interface_name, policy_ids (JSON array), dhcp_server_id, synced_at
- All schema additions use try/catch migration pattern (safe on existing databases)

### Implementation notes

**Cross-VDOM API calls:**
- FortiGate requires `vdom` field in the POST/PUT body for interface creation (not just query string)
- Static routes are created in the root VDOM using `vdomOverride` parameter on API requests
- VDOM link interfaces (`lab-root0` in lab, `lab-root1` in root) bridge inter-VDOM routing

**Idempotent provisioning:**
- `getInterface()` checked before creating VLAN interface — skips if exists
- `getPolicies()` checked before creating firewall policy — skips if srcintf already has a policy
- `getDhcpServers()` checked before creating DHCP server — skips if interface already has one
- Handles partial provision failures from previous attempts cleanly

**Live-query deprovision:**
- Rather than relying only on stored policy/DHCP IDs, cleanup queries FortiGate for ALL policies and DHCP servers referencing the interface name
- Prevents "entry is used by other entries" errors when stored IDs are stale or incomplete

### Files added
- `backend/src/fortigate.js` — FortiGate REST API wrapper: `FortiGateAPI` class, `provisionVlan()`, `deprovisionVlan()`, `createClient()`, `vlanTagToSubnet()`

### Files modified
- `backend/src/db.js` — `firewalls` and `firewall_vlan_sync` tables + migration columns
- `backend/src/routes/admin.js` — Firewall CRUD routes, VLAN sync routes, subnet preview route, enhanced VLAN delete, audit-log action filter fix
- `frontend/src/pages/admin/FirewallsPage.jsx` — NEW: firewall management UI
- `frontend/src/pages/admin/VLANsPage.jsx` — Subnet column, sync controls, SyncModal, enhanced delete confirm
- `frontend/src/pages/admin/AuditLogPage.jsx` — Added firewall action types to filter dropdown
- `frontend/src/App.jsx` — Added `/admin/firewalls` route
- `frontend/src/components/Layout.jsx` — Added Firewalls nav link

---

## 2026-03-07 — Major Feature Update: LXC, Snapshots, Audit Log, Dashboard Overhaul

### LXC container support
- `getAllVMs()` now returns both qemu VMs and LXC containers from Proxmox
- All VM routes (status, actions, config, VNC, RRD) try qemu first, fall back to LXC automatically
- New backend functions: `getLXCStatus`, `lxcAction`, `getLXCConfig`, `updateLXCConfig`, `getLXCRRD`, `getLXCVNCTicket`
- VMCard shows "LXC" badge for containers, offline text says "Container is offline"
- Dashboard type filter: All / VM / LXC

### VM snapshots
- Browse, create, rollback, and delete snapshots from the VM detail page
- New SnapshotsSection component on VMPage with create form (name, description, include RAM state)
- Inline rollback confirmation before executing
- Backend: `getSnapshots`, `createSnapshot`, `deleteSnapshot`, `rollbackSnapshot` in proxmox.js
- Routes: `GET/POST /:node/:vmid/snapshots`, `DELETE /:node/:vmid/snapshots/:snapname`, `POST /:node/:vmid/snapshots/:snapname/rollback`
- All snapshot actions are audit-logged

### Audit logging
- New `audit_log` table tracks all significant actions with user, IP, timestamp
- Logged events: login, login_failed, vm_action, backup_create, backup_delete, vm_restore, vlan_change, vm_clone, vm_create, snapshot_create, snapshot_delete, snapshot_rollback, admin_create_user, admin_delete_user, admin_reset_2fa, admin_unlock_user, admin_reset_password
- `backend/src/utils/audit.js` — `logAudit(req, action, target, detail)` helper
- Admin page: `/admin/audit-log` with paginated table, action type filter, color-coded badges
- Captures IP from `X-Forwarded-For` header (works behind Nginx Proxy Manager)

### Dashboard overhaul
- **Search**: filter VMs by name or VMID with live text search
- **Status filter**: pill buttons for All / Running / Stopped
- **Type filter**: pill buttons for All / VM / LXC
- **Sort**: dropdown to sort by Name, VMID, Status, CPU usage, or Memory usage
- **Summary stats bar**: shows average CPU, total RAM usage, and running VM count across all running VMs
- **Bulk actions**: checkbox selection on VM cards, "Select All", bulk Start / Shutdown / Force Stop with confirmation dialog
- **Empty filter state**: "No VMs match your filters" with clear-all button

### Persistent session store
- Replaced Express MemoryStore with `better-sqlite3-session-store`
- Sessions now persist across backend restarts and don't leak memory
- Auto-cleanup of expired sessions every 15 minutes

### Files added
- `backend/src/utils/audit.js` — audit logging helper
- `frontend/src/pages/admin/AuditLogPage.jsx` — admin audit log viewer

### Files modified
- `backend/package.json` — added `better-sqlite3-session-store`
- `backend/src/index.js` — SQLite session store, moved db import to top
- `backend/src/db.js` — audit_log table migration
- `backend/src/proxmox.js` — LXC functions, snapshot functions, getAllVMs includes LXC
- `backend/src/routes/vms.js` — LXC fallbacks on all routes, snapshot CRUD routes, audit logging
- `backend/src/routes/auth.js` — audit log on login/login_failed
- `backend/src/routes/admin.js` — audit log on user management actions, audit-log endpoint
- `backend/src/routes/provision.js` — audit log on clone/create
- `frontend/src/pages/Dashboard.jsx` — search, filter, sort, bulk actions, stats bar
- `frontend/src/components/VMCard.jsx` — selection checkbox, LXC badge
- `frontend/src/pages/VMPage.jsx` — SnapshotsSection component
- `frontend/src/App.jsx` — audit-log route
- `frontend/src/components/Layout.jsx` — audit-log nav link

---

## 2026-03-07 — Security Hardening for Internet Exposure

### Session security
- Removed hardcoded fallback session secret (`'change-me'`) from backend; `SESSION_SECRET` is now required via env
- Generated a strong 256-bit random secret in `.env`
- `COOKIE_SECURE` is now configurable via env; set to `true` for HTTPS (lab.aaris.tech)

### CORS lockdown
- When `ALLOWED_ORIGIN` is set (e.g. `https://lab.aaris.tech`), only that exact origin is allowed
- When unset, the requesting origin is reflected (for local/dev access)
- Previously all origins were accepted by default — any website could make authenticated API calls

### Proxmox credentials cleanup
- Removed hardcoded Proxmox API token and host from `docker-compose.yml`
- Removed env-var seeding logic from `db.js` — PVE hosts are managed entirely via the admin UI
- Credentials now only live in the SQLite database (never in version-controlled files)

### HTTP security headers (nginx)
- `X-Frame-Options: DENY` — prevents clickjacking
- `X-Content-Type-Options: nosniff` — prevents MIME-type sniffing
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `server_tokens off` — hides nginx version

### Error message sanitization
- Created `backend/src/utils/sanitize.js` with `sanitizeError()` utility
- All 500 error responses now strip internal IP addresses and Proxmox API paths before reaching the client
- Global Express error handler added in `index.js` as a catch-all
- Applied across `vms.js`, `provision.js`, and `admin.js` routes

### Content-Disposition header injection fix
- Backup download filenames are now sanitized (strips quotes, newlines, backslashes, non-ASCII)
- Prevents HTTP response header injection via crafted Proxmox backup paths

### Password policy
- Minimum password length raised from 4 to 8 characters

### Environment / config
- Created `.env` file with `SESSION_SECRET`, `ALLOWED_ORIGIN`, `COOKIE_SECURE`
- Created `.gitignore` to prevent `.env` from being committed
- `docker-compose.yml` now uses `${SESSION_SECRET:?...}` to fail fast if secret is missing

### Files added
- `.env` — environment secrets (gitignored)
- `.gitignore`
- `backend/src/utils/sanitize.js` — error message sanitizer

### Files modified
- `docker-compose.yml` — removed hardcoded Proxmox creds, added `COOKIE_SECURE` env
- `backend/src/index.js` — strict CORS, removed secret fallback, global error handler, sanitizeError import
- `backend/src/db.js` — removed Proxmox env-var host seeding
- `backend/src/routes/vms.js` — sanitized error responses, sanitized Content-Disposition filename
- `backend/src/routes/provision.js` — sanitized error responses
- `backend/src/routes/admin.js` — sanitized error responses
- `backend/src/routes/auth.js` — minimum password length 4→8
- `frontend/nginx.conf` — security headers, server_tokens off

---

## 2026-03-06 — Backup Management & File-Level Restore

### Backup management on VM detail page
- Added backup section to `VMPage.jsx` with list of all backups across all backup-capable storages
- Create new backups with configurable storage, mode (snapshot/suspend/stop), compression (zstd/lzo/gzip/none), and optional notes
- Delete backups with confirmation dialog

### Full VM restore
- Restore a VM entirely from any backup with a single click
- Confirmation panel with warning, optional target storage selector
- Backend route: `POST /api/vms/:node/:vmid/restore` calls `restoreVMBackup()` in proxmox.js
- Uses Proxmox `POST /nodes/{node}/qemu` with `archive` and `force: 1`

### File-level restore (browse & download)
- Browse backup contents via Proxmox file-restore API
- Navigable file browser: volumes (disk images) -> directories -> files
- Breadcrumb navigation with path stack (not string-based, since Proxmox uses base64-encoded opaque filepath tokens)
- Download individual files or entire folders (folders download as `.tar.zst` archives)
- Backend proxies downloads via Node `https.request` (not `fetch`, which doesn't support custom TLS agents)

### Key implementation details

**Proxmox file-restore API quirks:**
- `GET /nodes/{node}/storage/{storage}/file-restore/list?volume={volid}&filepath={path}` returns entries with:
  - `type`: `'v'` (volume/disk), `'d'` (directory), `'f'` (file)
  - `filepath`: base64-encoded opaque token — must be passed back as-is to navigate deeper
  - `text`: human-readable display name
  - `leaf`: `0` = navigable, `1` = leaf
- Root listing (`filepath=/`) returns disk volumes, not filesystem directories
- Must click into a volume first to see the actual filesystem

**Route patterns for volids with slashes:**
- Proxmox backup volids contain slashes (e.g. `pbs-01:backup/vm/119/2026-03-06T20:10:38Z`)
- Express `/:volid` only captures up to the first slash — use `/*` wildcard and read `req.params[0]` instead
- Frontend must NOT `encodeURIComponent()` the volid in URLs — let the slashes pass through naturally

**Download proxy:**
- Node `fetch()` does not support the `agent` option for TLS — must use `https.request()` with the existing `rejectUnauthorized: false` agent
- Filenames from Proxmox are base64-encoded paths — decode with `Buffer.from(filepath, 'base64').toString('utf-8')` and extract last segment
- Directories are returned as tar archives — append `.tar.zst` to filename when content-type indicates archive and name has no extension

### Files modified
- `backend/src/proxmox.js` — Added `getVMBackups`, `createVMBackup`, `restoreVMBackup`, `deleteVMBackup`, `getBackupStorages`, `listBackupFiles`, `downloadBackupFile`
- `backend/src/routes/vms.js` — Added backup CRUD routes, restore route, file-browse and download routes (all with `/*` wildcard for volid)
- `frontend/src/pages/VMPage.jsx` — Added `BackupsSection` component with create/list/delete/restore/file-browser UI

---

## 2026-03-06 — VM Provisioning System

### Hybrid provisioning (template clone + full create)
- Users with `can_provision` permission can clone from admin-registered templates
- Admins can also create VMs from scratch with full config (CPU, RAM, disk, ISO, network, etc.)
- Provisioned VMs are auto-assigned to the requesting user

### Template management (admin)
- Admin page to register Proxmox VMs as clonable templates
- Auto-discover templates from Proxmox (VMs with `template: 1`)
- Configure defaults: cores, memory, disk size, storage, cloud-init flag
- Node/VM/storage dropdowns fetched live from Proxmox API

### Background task polling
- Clone/create operations return a Proxmox UPID
- `pollAndConfigure()` polls task status every 5 seconds, then applies post-clone config (cores, memory, disk resize)
- Frontend polls provisioning status for live updates

### Database schema additions
- `vm_templates` table — registered templates with defaults
- `provisioned_vms` table — provisioning job tracking
- `can_provision` column on `users` table

### Files added/modified
- `backend/src/routes/provision.js` — NEW: template CRUD, clone/create endpoints, resource listing, task polling
- `backend/src/proxmox.js` — Added `getNextVmid`, `cloneVM`, `createVM`, `resizeVMDisk`, `getStorages`, `getISOImages`, `getNetworks`, `getNodes`, `getTaskStatus`
- `backend/src/db.js` — Added `vm_templates`, `provisioned_vms` tables, `can_provision` migration
- `backend/src/index.js` — Mounted `/api/provision` routes
- `frontend/src/pages/ProvisionPage.jsx` — NEW: clone/create UI with live Proxmox resource dropdowns
- `frontend/src/pages/admin/TemplatesPage.jsx` — NEW: template management with auto-discovery
- `frontend/src/pages/admin/UsersPage.jsx` — Added `canProvision` toggle
- `frontend/src/App.jsx` — Added `/provision` and `/admin/templates` routes
- `frontend/src/components/Layout.jsx` — Added nav links for provisioning and templates

---

## 2026-03-06 — UI Polish: Icons, Favicon, Page Titles

### Favicon
- `frontend/public/favicon.svg` — Blue rounded square with monitor icon
- `frontend/index.html` — Added favicon link, meta description, theme-color

### Dynamic page titles
- `frontend/src/hooks/useDocumentTitle.js` — Custom hook: `useDocumentTitle('Page Name')` sets `<title>` to "Page Name - VM Manager"
- Applied to all pages: Dashboard, Login, Account, SSH Keys, VM detail, VNC, and all admin pages

---

## Architecture Reference

### Project structure
```
Proxmox-frontend/
  docker-compose.yml
  backend/
    src/
      index.js          — Express server + WebSocket VNC proxy
      db.js             — SQLite schema + migrations
      proxmox.js        — All Proxmox API wrappers
      middleware/auth.js — Session auth middleware
      routes/
        auth.js         — Login/logout/me
        vms.js          — VM status, actions, VNC, VLAN, backups
        admin.js        — User/VLAN/host/firewall management, audit log
        provision.js    — Template clone + full VM creation
        ssh.js          — SSH config + key management
      fortigate.js      — FortiGate REST API wrapper + VLAN provisioning
  frontend/
    src/
      api.js            — Axios instance
      App.jsx           — React Router setup
      components/
        Layout.jsx      — Sidebar nav
        VNCModal.jsx    — Embedded noVNC
        VLANModal.jsx   — VLAN tag editor
        SSHModal.jsx    — Web SSH terminal
        StatusBadge.jsx — VM status pill
      pages/
        Dashboard.jsx   — VM list
        VMPage.jsx      — VM detail + backups + file restore
        VNCPage.jsx     — Full-screen VNC
        ProvisionPage.jsx — Clone/create VMs
        LoginPage.jsx
        AccountPage.jsx
        SSHKeysPage.jsx
        admin/
          UsersPage.jsx
          VLANsPage.jsx
          AssignmentsPage.jsx
          PVEHostsPage.jsx
          TemplatesPage.jsx
          FirewallsPage.jsx
          AuditLogPage.jsx
      hooks/
        useAuth.js
        useDocumentTitle.js
```

### Proxmox API patterns
- All API calls go through `makeRequest()` in proxmox.js which handles auth headers and TLS
- Multi-host support: `hostForNode(nodeName)` finds which PVE host owns a node
- `makeRequest` does NOT send body on DELETE requests (`if (body && method !== 'DELETE')`)
- Download proxy uses `https.request()` not `fetch()` for TLS agent support
- Express routes use `/*` wildcard for Proxmox volids that contain slashes
