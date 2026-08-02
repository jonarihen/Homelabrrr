# Changelog

## 2026-08-02 — A role that grants firewall management now actually grants it

- **Firewall permissions handed out through a role work everywhere again.** A user whose `can_manage_firewalls` came from a role — including the built-in **Administrator** role — was treated as not having it in two places, with no error to explain why. The Firewalls admin page loaded with **host, port, VDOM, WAN interface and TLS verification blank**, and port forwarding quietly dropped to the restricted path: forwards could only be created for VLANs assigned to that user personally, and deleting a forward on any other VLAN was refused. Both now honour the role
- Permissions granted directly on the user account were never affected — only role-granted ones

## 2026-07-30 — Publish new sites without spending a FortiGate certificate slot

- **Homelabrrr now understands `caddy-forticertsync`'s inspection-bundle mode.** In that mode the firewall holds a *single* multi-SAN certificate covering every published domain, instead of one certificate per site competing for the profile's 10 slots. Set the bundle's base name (e.g. `homelabrrr_inspection`) on the Caddy server under **Admin → Websites**
- **With a bundle configured, publishing a site touches the FortiGate not at all.** The pipeline stops waiting for a per-site certificate to sync and stops writing to the inspection profile — the new hostname is already inside the bundle's `*.parent-domain` SAN, so the certificate and inspection steps complete immediately. A new site costs **zero** of the ten slots
- If the bundle name is set but the certificate is not on the firewall yet, publishing falls back to the old per-domain discovery instead of failing, so a half-finished migration still works
- **Deleting a site never detaches the bundle.** The shared certificate serves every site, so the slot-freeing cleanup added below correctly leaves it alone

## 2026-07-30 — Renewed certificates stop filling up the SSL inspection profile

- **A renewed certificate now replaces the one it supersedes.** `caddy-forticertsync` names every synced certificate `<domain>_<DDMMYYYY>`, so each renewal arrives under a new name — and Homelabrrr appended it next to last year's, which stayed attached. FortiOS allows only **10 server certificates per inspection profile**, and it refuses to delete a certificate that a profile still references, so the profile silently filled up until publishing any new site failed. Attaching a certificate now matches on the domain in the name and swaps the predecessor out in place, so a renewal costs no slot
- **A full profile is now reported as blocked, not as something to retry.** The failure used to surface as *"…attaching the certificate to SSL inspection failed. You can retry."* — advice that could never work, since the cap does not clear on its own. Publishing now checks the slot count *before* calling the firewall and reports which profile is full and exactly which certificates hold its 10 slots, so it's clear what to free
- **A site covered by a wildcard certificate no longer takes a slot of its own.** If a wildcard already attached to the profile covers the hostname, the step completes without touching the firewall at all
- **Deleting a site frees its slot.** The certificate is detached from the inspection profile when no other site uses it — which is also what finally lets `caddy-forticertsync` delete the superseded certificate. It is never removed from the firewall's certificate store; that store belongs to the sync tool
- **FortiGate error messages read as text again.** FortiOS HTML-escapes its CLI errors, so they arrived showing `&#40;` and `&#41;` instead of brackets

## 2026-07-30 — The file browser's 100 MB upload limit is gone

- **Uploads are no longer capped.** The file browser refused anything over 100 MB, and a file past that was rejected by the web server before the portal ever saw it — so the browser could only show a bare "Upload failed" with no hint that a limit existed at all. The limit is removed; free space on the target VM is now the only thing that bounds an upload
- The cap was really a memory ceiling in disguise: every upload was held in the backend's RAM in full before a single byte was written to the VM. Uploads now **stream straight through** to the VM's disk, so the backend's memory use is flat whether the file is 1 MB or 100 GB, and several people can upload large files at once without starving each other
- **Uploads show progress** — the file name, a percentage, and a position in the batch when several files are selected at once. Previously a multi-gigabyte transfer was an indefinite "Uploading..." with nothing behind it
- **A transfer that dies part-way no longer leaves a corrupt file behind.** If the connection drops or the tab is closed mid-upload, the half-written file is removed from the VM rather than left sitting there at the right name with the wrong contents
- Long uploads no longer expire out from under themselves. A file browser session times out after 30 minutes idle, which a large transfer could outlast — the session is now kept alive while the transfer runs, so the next file in a batch isn't rejected

## 2026-07-28 — A dropped console no longer takes the whole backend down with it

- **Fixes a crash that logged everyone out.** When a Proxmox VNC console ended without a clean close — the guest rebooting, the node dropping the connection, a network blip — the backend forwarded that closure to the browser verbatim and the websocket library rejected it, killing the entire Node process. Every other user's session went down with it, and Docker restarted the container
- The close codes involved (`1005`, `1006`) are ones a websocket only ever *reports* locally; the spec forbids sending them on the wire. They are now filtered to a plain no-status close, and no close frame can take the process down regardless

## 2026-07-28 — A backup in progress no longer looks like a finished one

- **Manual backups now show that they are still running.** Proxmox lists the archive it is writing the moment it creates the file, so a fresh backup appeared in the list within seconds — complete with a size, and with Restore and Delete live on it — while vzdump was still filling it in. There was nothing to tell a finished backup from a half-written one
- The Backups section now shows a **progress panel** with the real percentage scraped from the Proxmox task log, and the archive being written is badged **Backing up** with Restore, Delete and Browse held back until it finishes. Its size, encryption and verification tags stay hidden while they would be meaningless
- **Progress survives a page reload and a backend restart**, because the task is tracked in the portal database rather than in the open tab — backups routinely outlive the tab that started them
- **A dump that fails after it was submitted now says so.** Previously the failure was silent: the leftover partial archive just sat in the list looking like a normal backup. The section now reports the failure and warns that the archive it left behind is incomplete
- The **Backup failed** notification fires when the dump itself fails, not only when submitting it fails. **Backup created** now fires on completion instead of at submission, so it means the backup actually exists
- Containers back up with rsync, which reports no percentage — those show a running indicator instead of a bar, as does the first moment of any backup before Proxmox prints its first progress line

## 2026-07-28 — Reconnect a dropped SSH or VNC console without closing it

- **A console that loses its connection can now be reconnected in place.** Previously a dropped SSH shell or VNC session was a dead panel — the only way back was to close the console and open a new one from the VM page
- A **Reconnect** button appears in the console toolbar as soon as the connection drops, errors out, or fails to come up at all. It's hidden while connected and while a connection is still being attempted
- **SSH** reconnects with the key, host and passphrase you originally connected with, so you don't go back through the connect form. Scrollback from the dead session is not carried over — it's a new shell
- **VNC** requests a fresh console ticket and re-attaches. The connection-lost overlay now carries its own Reconnect button, and the popped-out VNC window no longer has to reload the whole page to retry
- Applies to both the docked consoles and the popped-out `/ssh` and `/vnc` windows

## 2026-07-28 — Edit a published website instead of deleting and republishing it

- **Published websites now have an Edit button.** Pointing a site at a different VM or port meant deleting it and publishing it again from scratch; the card now opens an inline form for the upstream host and port and re-pushes the route to Caddy when you save
- Your assigned VMs are one click away in the form, same as when publishing, and Save stays disabled until something actually changes — so a live site is never sent back through the publish steps for nothing
- The domain itself is still fixed (it is the certificate's subject), and the button is hidden while a site is mid-publish

## 2026-07-27 — Invite links no longer bounce to the sign-in page

- **Following an invite link works again.** The invite page dropped straight to the sign-in form instead of the "Claim Invite" panel — an invitee has no account yet, so there was nothing they could do from there
- The app checks who you are on every page load; on the invite page that check correctly says "not signed in", but the response handler treated it as an expired session and redirected. Public pages (invite redemption, sign-in) now stay put, while a real session timeout anywhere else still returns you to sign-in as before

## 2026-07-26 — Migration shows real transfer progress

- **Cross-host migration now has a progress bar.** A long disk copy used to look identical at minute 1 and minute 90 — a pulsing dot and "Migration running…". The portal now reads the Proxmox task log and shows the actual percentage plus the current *transferred X of Y* line, so it's obvious whether the transfer is moving and roughly how much is left
- **Full-copy (`remote_migrate`) migrations get a step list too** — prepare / transfer / finalize — instead of a blank panel; the bar sits on the transfer step
- **Shared-storage (adopt) migrations** show the same bar on the two long steps ("Moving local disks to shared storage" and "Moving boot disks to target storage"), which previously sat on "active" for the whole copy
- Progress is stored with the migration, so **closing the tab, reloading the page or restarting the backend picks the bar back up mid-transfer**
- The Assignments banner shows the percentage next to *migrating…*
- Containers copy with rsync, which reports no percentage — those keep the running indicator, as does the early phase of any migration before the first progress line appears

## 2026-07-25 — One-click resolution for the stale-boot-order migration block

- When a **running** VM can't be migrated because its boot order names a device that no longer exists, the migrate dialog no longer just explains and stops — it offers two **one-click** choices: **Reboot to apply the fix** (a short blip, then start a live migration) or **Stop & migrate offline now** (down during the copy, but no reboot)
- Stop & migrate handles the whole sequence: it stops the VM, waits for it, and starts the migration — the backend corrects the boot order automatically once the VM is off, then moves it
- The dialog shows the exact bad boot order and the correction, so it's clear what's happening. Nothing changes for VMs with a valid boot order

- **Fixes the raw `machineid=…;hostname=…;exit=success;type=shell` spam in the noVNC console.** systemd v257+ images (e.g. Ubuntu 26.04) ship an OSC 3008 "terminal context" shell drop-in that prints control sequences around every command. SSH terminals parse them silently, but the Proxmox VT console can't, so it shows them raw
- New **Patch console** button on each cloud image (Admin → Templates → Cloud Images). It runs `virt-customize` on the image's host to disable that drop-in (via a `dpkg` diversion, so a package update can't reinstate it) — **every VM deployed from the image afterward has a clean console**; already-deployed VMs are unaffected. The image is badged **✓ console patched**
- Safe on any image: it's a no-op on images without the drop-in (older systemd) or without `dpkg` (non-Debian) — so patching Debian/Rocky just reports "not needed"
- Requires the image's host to have **SSH configured** (Admin → PVE Hosts — the same SSH used for migration cleanup) and **libguestfs-tools** installed on that host; the button explains if either is missing
- Existing VMs can still be fixed in place: `sudo dpkg-divert --local --rename --add /usr/lib/systemd/profile.d/80-systemd-osc-context.sh` then re-login

- **A cloud image's default VM storage can now be set per host.** A shared-storage image deploys from several hosts whose local pool names differ (e.g. `bank-ssd` on one, `ssdpool` on another), so a single default couldn't fit them all — the disk just fell back to auto-pick on the other hosts
- The image's **Default storage** button (Admin → Templates → Cloud Images) now shows **one pool selector per host** the image can deploy to, each listing that host's own storages. The download host's pick is set on the add-image form; the rest are set here
- When deploying, the disk target is pre-selected from the **chosen host's** default (then the legacy single default, then auto); non-admin auto-placement uses each host's default too
- Images on local storage are unchanged — a single host, a single default

- **A cloud image on shared storage (NFS/CIFS) can now be deployed from any host that mounts that storage — not just the one it was downloaded on.** The image is downloaded once, but because the same disk is reachable by the same path from every host on that share, the portal now treats all of them as valid deploy targets
- **Admins** get a **Deploy host** selector on the Create VM → Cloud Image form whenever the image sits on shared storage; storage and network options follow the chosen host. Images on local storage still deploy only where they live
- **Non-admin auto-placement** now considers those shared-storage hosts too, so a deploy lands on whichever mounts-the-share host is least busy and has room — previously it could only pick the download host
- Host reachability is decided by the storage's real backend (NFS server+export / CIFS server+share), and the disk volume is addressed with the storage id as named on the target host, so it works even if the shared storage has a different id there

- **A VM whose boot order lists a device that no longer exists no longer breaks migration.** Proxmox aborted in phase 1 with `invalid bootorder: device 'sata0' does not exist` — the VM's boot list still named a disk that had been removed or moved to another bus (e.g. `sata0` after the disk became `scsi0`). The running source node tolerates the dangling entry; the target host validates the boot order strictly and refuses the config
- The check runs against the **active** (on-disk) config — the exact config Proxmox ships to the target — not the pending-merged view, so a change that has only been *staged* on a running VM no longer masks the problem
- **Stopped VM (offline / shared-storage migration):** the stale boot entry is dropped automatically before the config is handed over — a genuine fix that stands even if you keep the source, and it's recorded in the audit entry
- **Running VM (live migration):** Proxmox defers boot-order edits to the next start, so they can't be corrected live. The migration is now **refused up-front with a clear message** — *reboot the VM once to apply the fix then migrate live, or stop it and migrate offline* — instead of letting Proxmox abort a few seconds in
- No effect on VMs with a valid boot order

## 2026-07-25 — Shared-storage migrations can now clean up after themselves

- **The leftover source VM after a shared-storage migration can now be removed automatically.** Proxmox's API can only delete a VM *together with its disks* — fatal here, since the migrated VM keeps using the same shared volumes — so the only safe removal is taking the `.conf` file off `/etc/pve`, which needs a root shell
- Each PVE host (Admin → PVE Hosts) can therefore get an **optional root SSH config** (key or password, encrypted at rest, host key pinned on first use). With SSH configured, an adopt-mode migration ends with a new **"Removing leftover source config"** step: the source VM must be verified stopped, then the config file is **archived to `/root/homelabrrr-migrated-<vmid>-<timestamp>.conf`** on the node (moved, not deleted — recoverable), and the migration reports the source as fully removed
- Without SSH the behavior is unchanged: leftover kept stopped + protected, manual one-liner shown — plus a hint that configuring SSH automates it next time
- SSH is used for nothing else; volumes are never touched over SSH

## 2026-07-25 — Fix: policy grouping now renders as real FortiGate sections

- **The sequence groups from this morning's grouping feature now actually merge in the FortiGate GUI.** The first pass stamped the group's `global-label` on *every* policy — but FortiGate treats a non-empty label as the *start of a new section* (a section is one labeled anchor policy followed by unlabeled ones), so each policy rendered as its own `(#2) (#3)` fragment even though the ordering was perfectly contiguous
- Grouping now follows FortiGate's real section semantics: **only the first policy of a group carries the label**, members below it have theirs cleared. **Run "Regroup policies" once** (Admin → Firewalls) to repair the fragments from the first pass
- New policies joining an existing group are parked at the section's true tail (including any unlabeled manual policies inside it) with their label cleared; the first policy of a brand-new group becomes the labeled anchor
- Heads-up: if the *anchor* policy of a group is deleted, the group's name disappears and its remaining members visually merge into the section above — the Regroup button repairs that too (the next member becomes the anchor)

## 2026-07-25 — Firewall policy sequence grouping that actually groups

- **Port forwards are now grouped per user** on the FortiGate: each root-VDOM policy gets a `Port Forwarding - <username>` sequence label (owner resolved from the target VM's assignment), so you can see at a glance who has what open — instead of one long "Port Forwarding (VM Manager)" list
- **Lab VDOM policies group by their source VLAN**: every policy coming from `vlanX` sits in that VLAN's sequence group; port-forward legs group per destination VLAN
- New policies are **inserted next to their group** instead of appended at the bottom — that append behavior is what caused the endless `(#2) (#3) (#4)` fragments in the FortiGate GUI (same label but not adjacent = new visual group)
- New **"Regroup policies"** button on each firewall (Admin → Firewalls) fixes the current mess in one click: rewrites the labels to the new scheme and moves every group together. Order inside a group is preserved; if you hand-placed custom deny rules between portal policies, review them after running
- Regroup runs are audit-logged with a change summary

## 2026-07-25 — Shared-storage migrations, smarter VM placement, host visibility

- **Migrations now understand shared storage** (admin): when both hosts mount the same NFS/CIFS share (e.g. `vdisks-nfs` from a TrueNAS box), disks on it are **never copied** — the migration dialog shows a per-disk plan where those disks are *remounted* on the target and only local disks (like an SSD boot disk) actually move. Boot disks travel via the shared storage and can land on the target's local SSD storage afterwards. Runs offline (stop the VM first); a "force full copy" escape hatch remains
- Proxmox cannot forget a VM without destroying its disks, so after a shared-storage migration the **source config stays behind, stopped and protected** — the portal shows the one-line cleanup command (`rm /etc/pve/qemu-server/<vmid>.conf`) and refuses to delete that leftover through the UI, so the shared disks can never be destroyed by accident
- **Cloud-image deploys pick the host per deploy**: admins choose the host via the image card (one card per host that has the image, labeled); **non-admin deploys are placed automatically** on the least-busy host that actually has room — a host at 96% storage / 98% memory is skipped even if it has fewer VMs. When no host has capacity, the deploy is refused with a clear "contact your admin on Discord" message
- **Everyone can now see which Proxmox host a VM runs on** — on the dashboard cards and the VM detail page. Moving VMs stays admin-only

## 2026-07-25 — Migrate VMs between separate Proxmox hosts

- Admins can now **move a VM or container to a different Proxmox host** — even hosts that are not clustered together (uses Proxmox `remote_migrate`, PVE 7.3+). Find the new **Migrate** button on each row of the Assignments page (shown when 2+ hosts are registered)
- Pick the target host, storage and network bridge in the dialog; the NIC's **VLAN tag is kept**, only the bridge is remapped. Running VMs can **live-migrate** (needs reasonably similar CPUs on both hosts — uncheck it and stop the VM first when moving between very different hardware); running containers are stopped, moved and restarted
- By default the source VM is **deleted after a successful migration**; untick "Delete source" to keep a stopped copy on the old host
- The portal follows the move automatically: user assignment, SSH settings and template registrations all point at the new host when the migration finishes. The VMID never changes
- Migrations run in the background — a progress banner on the Assignments page keeps tracking them even if you close the dialog or restart the portal, and every migration is audit-logged
- Pre-flight checks refuse migrations that clearly don't fit the target (free RAM / storage space), same as VM provisioning

## 2026-07-21 — Fix: port forwards for VMs with long names

- **Creating a port forward for a VM with a long name no longer fails** with `string value name is too long ... the limit is 35`. FortiGate caps object names at 35 characters, and the rule name derived from the VM name plus its service/port label (e.g. `minecraft-fi-lille-ven - Custom 25565/tcp`) routinely exceeded that
- Rule names are now **shortened deterministically**: short names are left untouched, long names keep a recognizable head and the trailing `Custom <port>/<proto>` label and gain a short `~<hash>` suffix so two long names that only differ after the truncated prefix still map to **distinct** FortiGate objects. The name shown in the form matches what is persisted on the firewall
- The bound accounts for the `PF: ` prefix on the auto-created firewall policy (also 35-char limited), so the fix covers both the VIP and its policy. The backend re-applies the limit as a hard guard even if a client submits an overlong name

## 2026-07-21 — Security: non-admins can no longer place VMs on the untagged/native network

- **Closed an authorization gap** where a non-admin could assign a VM to **untagged** (no VLAN) and land it on the native network where core infrastructure lives. VLAN access was only checked when a tag was present, so choosing "No VLAN (untagged)" / "Untagged (remove VLAN)" skipped the check entirely
- Non-admins must now place every VM on a **VLAN explicitly assigned to them** — for provisioning (clone, from-image, from-scratch) and for changing an existing VM's VLAN. The untagged/native network is **admin-only**; the backend refuses it with a clear error even if a client submits it directly. All four routes now share a single decision point (`utils/vlanAccess.js`)
- The untagged option is **hidden from non-admins** in the provisioning forms and the Change-VLAN modal. Admins are unaffected — untagged and any VLAN remain available

## 2026-07-21 — Cloud images can define a default target storage

- **Each cloud image can now carry an admin-defined default VM storage** — the pool a VM's disk lands on when you deploy directly from that image. Set it when adding an image, or later via the new **Default storage** button on each image row (**Admin → Templates → Cloud Images**). This mirrors how templates already carry a `default_storage`
- The **Create VM → Cloud Image** form pre-selects that default when you pick an image (falling back to `local-lvm`, then the first exposed pool, as before). The backend also falls back to it when no storage is submitted, so the default is authoritative — storage-exposure and identifier checks still apply
- Images with no default set keep the previous auto-pick behavior; existing images are unaffected (the column defaults to empty). Note: `default_storage` is the *target* pool for new VM disks, distinct from the image's download pool

## 2026-07-10 — Admins can publish ahead of DNS + publish shortcut on the admin page

- **Admins are no longer hard-blocked by the DNS pre-check** when publishing a site. Setups that legitimately fail it — a brand-new subdomain whose record isn't created yet, Cloudflare-proxied records (they resolve to CF edge IPs, never the homelab WAN IP), split-horizon DNS — now publish anyway for admins; the DNS step is recorded as *skipped* with the check's result attached. Non-admins still need the domain to point at the WAN IP first
- The DNS check hint in the publish form tells admins the failing check won't block them
- The admin **Websites** page now has a **Publish site** button — publishing has always lived on the user-facing Websites page, which was easy to miss when working from the admin section. Domains already imported from the Caddyfile still refuse re-publishing (edit those in the Caddyfile instead)

## 2026-07-10 — Published sites survive Caddy reloads: Caddyfile sync + auto re-push

- **The reload problem is fixed.** Until now, sites published from the portal lived only in Caddy's admin API — any `caddy reload` from the Caddyfile (or a service restart) silently dropped them. Two complementary fixes:
- **Caddyfile sync (recommended):** configure an SSH target on the Caddy server (host, user, key or password) and Homelabrrr maintains a **snippet file on the Caddy host** (default `/etc/caddy/homelabrrr.caddy`). Every publish/update/delete regenerates the file over SFTP, runs `caddy validate`, and reloads — a failed validation **rolls the snippet back and never touches the running config**. One-time setup: add `import /etc/caddy/homelabrrr.caddy` at the end (top level) of your Caddyfile — Homelabrrr creates the file (even empty) the moment you save the SSH settings, so the import line never breaks a reload. From then on **your own reloads and restarts include the portal's sites by construction**
- Snippet sites under a wildcard block (e.g. `new.aaris.tech` with `*.aaris.tech {}` present) are written as plain site blocks: Caddy sorts exact hosts above wildcards and **reuses the managed wildcard certificate** instead of attempting per-domain issuance
- SSH host keys are **pinned on first use** (mismatch aborts the sync); the SSH credential is encrypted at rest like every other secret
- **API-only mode self-heals:** servers without SSH keep the admin-API push, but a background reconcile now **re-pushes any managed route missing from the live config every 5 minutes**, and the server card shows dropped routes with a **Sync now** button for an immediate repair
- Server cards show the active mode (**Caddyfile sync** / **API only**); syncs and repairs are audit-logged

## 2026-07-10 — Import existing Caddy sites + wildcard certificate support

- Registering a Caddy server now lets you **pull in the sites that already exist in its Caddyfile**: an **Import sites** button on each server card (and automatically right after adding a new server) reads the running config through the admin API, lists every discovered site with its upstream, and imports the ones you select
- **Wildcard site blocks are fully understood**: hostnames handled inside a block like `*.aaris.tech { @app host app.aaris.tech; handle @app { ... } }` are discovered individually and tagged with the covering wildcard. Access-restricted sites (IP allowlists / basic auth) get a **restricted** badge; `file_server`/static sites are recognized too
- Imported sites are **tracked read-only** (badged *imported*): they occupy their domain so nobody can publish over them, but Homelabrrr **never edits or deletes routes it didn't create** — the Caddyfile stays the source of truth. Deleting an imported site only removes it from the portal
- **Publishing new sites under a wildcard now works with wildcard certs**: when the domain is covered by an existing wildcard block (e.g. `new.aaris.tech` under `*.aaris.tech`), the route is nested **inside that block** before its catch-all — so the existing DNS-challenge wildcard certificate serves the site and no doomed per-domain issuance is attempted
- FortiGate SSL-inspection cert matching is now **wildcard-aware**: for sites under a wildcard it also looks for the synced wildcard certificate (e.g. `wildcard_aaris_tech` as created by caddy-forticertsync), not just per-domain names
- Custom Caddy plugins and global `events` handlers (like the forticertsync cert-sync hook) are ignored safely during import — only `apps.http` is inspected

## 2026-07-10 — Fix: VLAN deletion through the workflow engine

- Deleting a VLAN synced by the new workflow engine no longer fails with a partial-cleanup error. The artifact teardown now removes the **switch-controller VLAN registration last** (FortiLink ties it to the VLAN interface, so it can only go once the interface is gone — the same order the pre-engine code used) and treats a refusal there as a warning, not a blocker
- Teardown is now **idempotent**: objects that are already gone on the FortiGate (e.g. removed by an earlier partial attempt) count as cleaned up, so retrying a failed delete completes instead of erroring forever

## 2026-07-10 — Users can build VMs from scratch with the Create VMs permission

- The **Create VMs** permission (`can_create_vms`) is now wired up: a user who holds it (directly, or via a role) can build a VM **from scratch / from an available ISO** on the **From Scratch** tab of the New VM page — no admin rights needed
- Non-admin builders are constrained the same way as the cloud-image flow: the **network bridge is pinned to the default (vmbr0)** — the bridge picker is hidden — the **VM is self-assigned to the creator** (the Assign-to field stays admin-only), only VLANs the user has access to can be tagged, and owner/VLAN PVE tags are stamped as usual. Node capacity and per-user quota checks still apply, and the deployment progress stepper works exactly as it does for the other flows
- Admins can grant **Create VMs** per user on the Users page (next to Provision VMs) or on a role — the toggle now takes effect everywhere
- Users without the permission are unchanged: the From Scratch tab stays hidden and both the create route and the ISO listing return 403

## 2026-07-10 — ISO catalog: download and manage installer ISOs

- New **ISO Catalog** on the Templates admin page (alongside Cloud Images): paste a name + URL + node + storage (and optional SHA256 checksum) and Proxmox downloads the ISO onto the storage as `iso` content, with live downloading / ready / error status polling — the same UX as the cloud-image catalog
- List all catalogued ISOs with size and status; **Remove** deletes both the PVE volume and the catalog row
- Download URLs are validated against internal/reserved addresses (same SSRF guard and `ALLOW_INTERNAL_IMAGE_URLS` opt-out as cloud images); actions are audit-logged
- Gated behind the same **Manage Templates** permission cloud images use. (The from-scratch create-VM ISO picker that consumes this catalog ships with #20.)

## 2026-07-10 — Admin-controlled storage pool exposure

- Admins can now choose **which Proxmox storage pools users may deploy onto**. Each PVE host on the **PVE Hosts** page lists its discovered pools with an **exposed to users** toggle.
- Hidden pools disappear from the storage dropdowns for non-admins (clone, from-image, from-scratch create) **and are rejected server-side** if named directly in a request — the dropdown is never trusted.
- **No behavior change until you restrict a pool:** every existing pool is exposed by default, so current deployments are unaffected until an admin hides one.
- Admins always see and can use every pool. Every exposure toggle is written to the **audit log**.

## 2026-07-10 — Node maintenance mode (soft drain)

- Admins can now put a **Proxmox node into maintenance** from the **PVE Hosts** page: each node has a **Drain** button that opens a small dialog for an optional reason and expected end time. While a node is draining, its node card turns **amber** with a `Maintenance` badge
- **Effects while active:** all provisioning paths (clone from template, deploy from cloud image, create from scratch) **reject the node** with a clear error — `Node pve1 is in maintenance until ~18:00 (Kernel upgrade)…`; the node is **greyed out in the New VM node picker** with its reason; and an **Overview notice is auto-published** so every user sees it at login
- **Overview health** treats a drained node as **amber "maintenance"**, never a red "down"/"Degraded" state — the host is still reachable, so there's no false outage
- **Running VMs are untouched** — this is a soft drain, not an evacuation
- **Auto-expire:** if you set an end time, maintenance **lifts itself** on a background tick and the notice closes automatically. Ending it manually does the same immediately
- The auto-published notice is system-managed (it can't be edited or deleted by hand — end maintenance to close it). Entering and exiting maintenance is **audit-logged**

## 2026-07-10 — Background PVE tag auto-sync

- The portal now **re-stamps owner + VLAN tags automatically in the background** on a schedule (default every **6 hours**), correcting drift caused by tags edited in the raw Proxmox UI, renamed VLANs, VM migrations/restores, or assignment writes that missed an unreachable node — no one has to remember to press a button
- New **auto-sync status card** on the Assignments page: shows whether auto-sync is armed / paused / running, the interval, and a summary of the last run (time, duration, checked / updated / failed counts) with an expandable list of per-VM failures
- **Pause / Resume** switch for auto-sync (e.g. during migrations or manual tag surgery). The paused state **survives backend restarts** and records who paused it and when
- The interval is admin-configurable from the same card
- The existing **Sync now** button now streams live progress (checked / updated / failed) and refuses to start a second run while one is already in flight (scheduled or manual)
- Manual tags outside the portal's `<username>` and `vlan-*` namespaces are still left untouched. Scheduled runs, manual runs, and pause/resume are audit-logged as summary lines

## 2026-07-10 — Invite links for one-click onboarding

- Admins can now **generate one-time invite links** from the Users page. Pick a role or individual permissions, resource quotas, VLAN access, an expiry, and whether the new account must enroll in 2FA — then copy a single-use URL to share (e.g. paste into Discord). Users with **Manage Users** (but not full admin) can also generate invites, but — exactly as when they create an account by hand — those invites produce a **basic account only**; attaching a role, permissions, quotas, or VLAN access stays admin-only.
- The invitee opens the link, sees exactly what access they'll get, **picks their own username and password**, and — if the invite requires it — is dropped straight into 2FA enrollment before anything else. On success they land on the Overview page already signed in, with the preset's permissions, quotas, and VLAN access applied.
- Open invites are listed on the Users page with their preset, creator, expiry, and status; unused ones can be **revoked**. Used, expired, or revoked links show a clear error and can't be redeemed twice.
- Security: invite tokens are **stored hashed** (only a SHA-256 hash is kept — the raw token is shown once and never persisted), redemption runs inside a single transaction, the public endpoints are **rate-limited like login**, and every generate/consume/revoke is **audit-logged**.

## 2026-07-10 — VM leases: expiry with auto-stop and one-click renewal

- Every provisioned VM now gets a **lease** — a TTL that starts at provisioning. VM cards and the VM page show a countdown badge (e.g. **"Expires in 12 days"**) that turns amber near expiry and red once expired
- Owners can **renew** in one click from the VM page — it resets the clock and bumps a renewal count that admins can see
- On expiry a background checker **gracefully stops** the VM (never deletes it) and flags it. After an admin-configurable **grace period** it appears in a new admin **VM Leases** reclaimable list for manual deletion
- Owners get an **Overview notice** on their dashboard when a VM has expired (and been stopped) or is expiring soon, with one-click links to renew
- New admin **VM Leases** page (Infrastructure section): set the **default lease duration** and **grace period**, see the whole roster with owner + live status, **renew / adjust / extend** any lease, **exempt** infra VMs so they never expire, run the sweep on demand, and **backfill** leases onto VMs that predate the feature
- All lease actions (auto-stop, renew, adjust, sweep) are audit-logged; the sweep runs `system` audit entries. Discord expiry warnings remain a separate feature (#22)
## 2026-07-10 — Discord webhook notifications

- New **Notifications** admin page (Access section of the sidebar): add one or more **Discord webhooks**, tick which event types each one receives, and hit **Send test** to confirm the wiring end-to-end
- Events sent as compact Discord embeds (event, VM/resource, owner, status, and a link back to the portal page): **VM deployment finished / failed**, **backup created / failed**, **node unreachable / recovered**, **new notice published**, and **account locked out** (security)
- Webhook outages can never break a flow — sends are **fire-and-forget** and rate-limited per webhook to stay under Discord's ~30 requests/minute
- Webhook URLs are **encrypted at rest** and only ever shown masked; every webhook config change is audit-logged
- Users can **opt out** of notifications about their own resources from the Account page
- New env knobs: `PORTAL_BASE_URL` (link-back base for embeds, falls back to `ALLOWED_ORIGIN`) and `NODE_HEALTH_POLL_MS` (health-monitor interval; `0` disables it)
## 2026-07-10 — Personal API tokens for scripting

- You can now create **personal API tokens** from the Account page and use them to script against the portal — `curl`, cron jobs, CI, Terraform-style tooling — without your session cookie or juggling 2FA. Send the token as `Authorization: Bearer <token>`.
- A token acts as **you**: it carries exactly your permissions, VM ownership, and quotas, resolved live on every request, so a token is never more powerful than its owner and any role change takes effect immediately.
- The plaintext secret is shown **once** at creation and never again — only a SHA-256 hash is stored. Give each token a name, an optional expiry (7/30/90/365 days or never), see when it was last used, and **revoke** it instantly.
- Sensitive account operations — managing tokens, changing your password, and anything touching 2FA — are **interactive-session only** and are rejected over token auth. VNC/SSH consoles also stay session-only.
- Every token-authenticated action is attributed in the **audit log** as `username (token: <name>)`; creation and revocation are logged too. Failed token attempts are rate-limited like logins.
- Admins can **list and revoke** any user's tokens from the new API Tokens tab in the Users → Manage dialog.
## 2026-07-10 — Per-VM power schedules

- VMs can now sleep on a schedule: open a VM and hit **Schedule** to set an automatic **stop time, start time, active days, and timezone** (e.g. stop 23:00, start 08:00 on weekdays) so idle dev VMs stop holding cluster memory overnight
- The backend enforces it every minute: a **graceful shutdown** is tried first, with a **hard-stop fallback** after a timeout, and the VM is started again at the configured time — all evaluated in the schedule's IANA timezone (DST-aware) on the chosen days
- **Manual overrides always win** — manually starting a VM inside its off-window keeps it running until the *next* scheduled stop, and a **Skip tonight** button skips just the next shutdown before normal enforcement resumes
- Schedule state is visible at a glance: a **"sleeps 23:00–08:00"** badge shows on the VM card and the VM page header
- Owners edit their own VM's schedule (**admins can edit any**); every automatic stop/start (and its outcome) is written to the **audit log**
## 2026-07-10 — Self-service website publishing (Caddy + FortiGate SSL inspection)

- New **Websites** page: publish a domain through the homelab reverse proxy without an admin hand-editing Caddy. Enter a domain, pick an upstream target, and Homelabrrr validates DNS, pushes the reverse-proxy route to the external **Caddy** admin API, waits for the Let's Encrypt certificate, and attaches the synced cert to the **FortiGate SSL/SSH inspection profile** — shown as a live step-progress flow like the VM deploy stepper
- **DNS guardrail**: a domain is rejected with a clear message unless its A record (CNAMEs followed) points at the homelab WAN IP — the error tells you exactly what to point where
- **Ownership guardrails**: users only ever see their own sites; a non-admin can only proxy to targets they own (an assigned VM's IP or an address inside their own VLAN subnet); a domain already published by someone else can't be claimed. Homelabrrr only ever touches the Caddy routes it created (each tagged `@id homelabrrr-<site-id>`) and never accepts raw Caddyfile/JSON — the route JSON is built server-side from validated fields
- **Admin Websites page**: register the external Caddy server once (admin API URL, optional auth, TLS verify), configure the homelab WAN IP (manual or auto-read from the linked FortiGate), pick the SSL/SSH inspection profile, see **every** published site with its owner, and reassign site ownership
- New **Manage Websites** permission (grantable per-user or via a role); Caddy admin-API credentials are **encrypted at rest**; every site create/update/delete/assign is **audit-logged**; DNS-validation checks are rate-limited
- **Security note**: the Caddy admin API is unauthenticated by default — keep it on a management VLAN Homelabrrr can reach, or front it with mTLS / a token-checking proxy. Never expose `:2019` to untrusted networks (see README)
## 2026-07-10 — Configurable FortiGate provisioning workflows

The hardcoded FortiGate provisioning sequences are now a **configurable workflow engine**. Each flow — provision a VLAN, create a port forward, create an inter-VLAN policy, and their teardowns — is an ordered list of whitelisted steps you can reorder, enable/disable, parametrize, and extend, per firewall. Homelabrrr no longer assumes one specific vdom-link topology, naming scheme, or subnet formula.

### What you get
- New admin **Workflows** page (under Infrastructure, gated on *manage firewalls*): step cards with **drag-to-reorder**, per-action parameter forms, a **variable picker** (`{{tag}}`, `{{subnet.network}}`, `{{externalPort}}`, `{{steps.iface.interfaceName}}`, firewall fields, …), enable/disable and continue-on-error toggles, and per-step run conditions.
- A **code-defined step catalog** (create VLAN interface, address/service objects, policy, static route, DHCP server, VIP, switch-port assignment, switch-controller VLAN) plus a power-user **custom API call** escape hatch (path must start with `/api/v2/`, size-limited body). The database only stores which steps run with which params — never arbitrary code.
- **Dry-run preview**: render the exact API calls a run would make against a sample VLAN / port forward without touching the firewall.
- **Run log** per execution — every step, request summary, result/error, and rollback — viewable in the UI.
- **Subnet derivation** (previously a hardcoded `10.x.y.0/24`) is now a workflow setting (first-octet), defaulting to the original formula.

### Safety
- On upgrade, built-in **default workflows are seeded that reproduce every previous hardcoded sequence exactly** — a VLAN sync and a port forward behave byte-for-byte as before until you edit the flow.
- Runs record every created object; **deprovision deletes those recorded artifacts in reverse order** rather than re-deriving from the current definition, so editing a workflow never orphans objects. Rows created before the upgrade keep working through the original teardown path.
- A failed run **rolls back everything it created**, in reverse. Every workflow edit, reset, dry-run, and run is written to the audit log.
## 2026-07-10 — Self-service cloud-init credential reset

- Cloud-init VMs now have a **Reset credentials** action on the VM page: set a new password and/or replace the injected SSH public key without asking an admin.
- The SSH public key can be **picked from your stored SSH keys** or pasted directly — the portal never stores the password.
- Because cloud-init only re-applies credentials on boot, the dialog explains a **reboot is required** and offers to reboot (or start) the VM inline so the change takes effect right away.
- The action only appears for VMs you **strictly own** that actually have a cloud-init drive; it stays hidden for everyone else (including view-only `see all VMs` users), and the reset event is written to the audit log **without** any secret.

## 2026-07-09 — Roles can carry default quotas

- Roles now have their own **CPU / memory / storage quota fields** — set them once on the role and every holder gets those limits. A per-user quota set on the Users page **overrides the role's value per metric** (leave a field empty to inherit); the Quotas tab shows the inherited value as the input placeholder
- The Roles table lists each role's quota next to its permission count

## 2026-07-09 — Per-user resource quotas

- Admins can now set **quotas per user** — max CPU cores, max memory (GB), max storage (GB) — on the new **Quotas** tab of the Users page Manage dialog. Empty = unlimited, so nothing changes for existing users until you set a limit
- Quotas count the **allocated** resources of the VMs assigned to the user and are enforced when creating a VM (cloud image, template clone, from-scratch) and when **raising** CPU/memory/disk on an existing VM — shrinking always works, and admins bypass quotas entirely
- Rejections say exactly what's wrong: `Memory quota exceeded: 6/8 GB allocated, request needs 4 GB more`
- The Users table shows each user's current allocation (red when a metric is at its limit), and users with a quota see **usage meters** at the top of the New VM page
- Quota changes are audit-logged

## 2026-07-09 — Roles: reusable permission sets you assign to users

- New **Roles** page (Access section of the sidebar): create a role, tick the permissions it grants, and assign it to users from the Users page — instead of clicking through ~14 checkboxes per account. **Editing a role instantly updates everyone who holds it**
- A user **with a role** gets exactly the role's permissions — the per-user toggles disappear from the Manage dialog while a role is assigned. A user **without a role** keeps their per-user toggles, so existing accounts behave exactly as before until you start using roles
- Two built-in roles ship out of the box: **Administrator** (every portal permission — note this does not make the account an admin) and **User** (no extra permissions). Built-ins can't be renamed or deleted, but their permissions are editable
- The Users page now shows each user's role, and the Manage dialog has a role dropdown above the permission toggles
- Role changes (create/edit/delete/assign) are audit-logged

## 2026-07-09 — Security: login lockout can no longer be weaponized to lock other users out

- Fixed a **targeted account-lockout denial of service**: the login lockout (10 failed attempts / 10 minutes) was keyed on the username alone, so anyone who knew a username — including `admin` — could lock that account from anywhere with ten bad passwords, and keep renewing the lock forever. Lockout is now keyed on **username + source IP**: an attacker only ever locks the account from their own address, while the real user logs in unaffected
- Depends on `TRUST_PROXY` matching your topology (see the earlier fix) so the recorded source IP is the real client and not the reverse proxy
- The admin Users page still shows a user as locked when any single address has hit the limit, and **Unlock** still clears all attempts for the account

## 2026-07-09 — Policy Mesh: zoom, route inspection, search, and keyboard control

- **Scroll to zoom** the mesh (40%–250%), anchored on the cursor — plus a **zoom control** with +/− buttons and the current percentage in the bottom-right corner. Recenter now also resets zoom
- **Click a route line** to open a small inspector: source → destination, service badges, allow/deny state, and a **Delete this policy** button — no more scrolling down to hunt for the row in the table
- **Find VLAN…** search box in the top-left corner of the mesh highlights matching nodes (by name or tag) and fades the rest — handy once the mesh grows past a dozen VLANs
- **Esc steps back out**: closes the create-policy modal, then the route inspector, then clears the selected source VLAN
- The service **legend now dims services that no current policy uses**, and shows a red **Deny** chip when deny rules exist
- Route tooltips **no longer clip** at the top or side edges of the canvas — they clamp inside and flip below the cursor near the top
- Fixed the mesh canvas not tracking container resizes (the resize observer attached before the canvas existed)

## 2026-07-09 — Audit log now records the real client IP behind a reverse proxy

- With an external reverse proxy (Caddy, Nginx Proxy Manager, …) in front, the audit log recorded the **proxy's IP** for every action instead of the actual client's. Cause: the request passes **two** proxies (external proxy + the bundled frontend nginx) but `TRUST_PROXY` defaulted to `1`, so Express stopped one hop short when walking `X-Forwarded-For`. The default is now `2`, matching the recommended topology. If clients reach port `8181` directly with no external proxy, set `TRUST_PROXY=1` in `.env` — otherwise a client could spoof its logged IP via a forged `X-Forwarded-For` header

## 2026-07-09 — Security: low-severity hardening round (L1–L9)

- **Login timing**: unknown usernames now take as long to reject as wrong passwords (dummy bcrypt compare), closing a user-enumeration side channel
- **`SESSION_SECRET` is validated at startup** — the backend refuses to boot with a missing or short secret instead of silently signing sessions with a weak one
- **Cloud-image downloads reject internal targets**: download URLs that resolve to loopback, RFC1918, link-local (`169.254.169.254`), or other reserved ranges are refused (blind-SSRF hardening). Homelabs with an internal image mirror can opt out with `ALLOW_INTERNAL_IMAGE_URLS=true`
- **SSH fingerprint scans are rate-limited** (10/min per user) and written to the audit log, so the scan endpoint can't be quietly used as an internal port probe
- The admin-only **full VM create** endpoint now validates `name`/`storage`/`bridge`/`ostype`/`bios`/`scsihw`/`iso` with the same strict identifier rules as the other provisioning routes
- **SFTP download filenames are sanitized** in the `Content-Disposition` header (quotes/control characters stripped, full name carried RFC5987-encoded)
- The frontend now sends a **Content-Security-Policy** header
- **`FRONTEND_BIND_ADDRESS` now defaults to `127.0.0.1`** in docker-compose, matching `.env.example` — set `0.0.0.0` explicitly if the UI must be reachable from other hosts. **Heads-up:** if you relied on the old default to expose port 8181 beyond localhost, add `FRONTEND_BIND_ADDRESS=0.0.0.0` to your `.env`
- Startup PPK key migration now uses `uuidv4()` temp filenames instead of `Math.random()`

## 2026-07-07 — Cluster CPU and memory meters on the Overview page

- The **System status** panel on the Overview page now shows **cluster-wide CPU and memory usage** — visible to every user, not just admins. CPU is core-weighted across all reachable nodes; memory shows used / total. The bars shift green → amber → red at 70% and 90% load, with the exact percentage always printed next to them

## 2026-07-07 — New welcome page after login

- Logging in now lands you on a new **Overview** page instead of the VM list — a quick glance at how the lab is doing before you dive in
- **System status** shows whether the platform is healthy (`All systems operational` / `Degraded` / `Major outage`) based on hypervisor reachability. Admins additionally see a per-host breakdown with PVE version, running VM counts, and fleet totals — regular users only see the overall state
- **Your VMs** summarizes your own machines (total / running / stopped) with quick links to each one and to the full VM list
- **Notices** let admins publish maintenance windows, warnings, and info messages that every user sees on login — create, edit, deactivate, and delete right on the page
- **Uplinks** is an admin-curated list of useful links (wiki, monitoring, Discord, …) shown to everyone
- The Overview page is also available from the top of the sidebar at any time

## 2026-07-07 — Security: session cookies are now Secure by default

- The session cookie's `Secure` attribute is now **on by default** — previously it was only applied when the operator explicitly set `COOKIE_SECURE=true`, so a deployment that forgot the variable shipped session cookies that browsers would also send over plain HTTP, exposing them to interception on any TLS-stripping hop. `COOKIE_SECURE` is now opt-**out**: set it to `false` only for plain-HTTP local development.

## 2026-07-07 — Security: reject malformed node names before they reach Proxmox

- Fixed a **path-injection / SSRF** weakness: a node identifier is interpolated into the Proxmox API path, and several endpoints did so without validation or URL-encoding. A crafted node name containing `/`, `..`, or `?` (e.g. `1~..%2F..%2F..%2Fversion%3F`) could steer a request made with the **privileged PVE API token** outside the intended `/nodes/<node>/…` path. Node names are now validated against a strict DNS-label pattern and rejected before any upstream request, and **every** node/storage segment is URL-encoded at the point of interpolation.
- The `GET /provision/nodes/:node/storages` endpoint was reachable by any logged-in user; it now requires provisioning or template-management permission, matching its sibling routes.

## 2026-07-07 — Security: restoring a backup now requires owning the VM

- Restoring a backup into a VM now requires the VM to be **assigned to you** (or being an admin), the same rule as VM deletion and backup deletion. Restore overwrites the VM's disks, so the "see all VMs" permission is no longer enough to trigger it on VMs you don't own.

## 2026-07-07 — Claim VMs and a grouped view on the Assignments page

- The admin **VM Assignments** page now lets you **claim** unassigned VMs — a per-VM **Claim** button assigns it to your own account, and a **Claim all unassigned** button grabs everything at once (handy for VMs that predate the portal)
- The assignments table is now **grouped for readability**: unassigned VMs at the top (amber header), then one section per user, each sorted by VMID with a per-group count

## 2026-07-07 — Security: deleting a backup now requires owning the VM

- Deleting a VM backup now requires the VM to be **assigned to you** (or being an admin), matching the rule that already applied to VM deletion. Previously the "see all VMs" permission was enough — users with read-everything visibility could delete backups of VMs they didn't own.

## 2026-07-07 — Security: backup operations now verify the backup belongs to the VM

- Fixed a **high-severity access-control gap**: the backup browse, download, restore, and delete endpoints checked that you had access to the VM in the URL, but not that the backup volume you named actually belonged to that VM — so access to any one VM was enough to read, restore, or delete **any** VM's backups. The backend now requires the VMID embedded in the backup volume ID (both vzdump archives and PBS snapshots) to match the VM in the URL, and rejects anything it can't parse.

## 2026-07-07 — Backups grouped by storage, with encryption and verification status

- The VM **Backups** panel now groups backups **by the storage they live on** instead of one flat list — each storage gets its own collapsible section with the storage type (PBS, NFS, directory, …), backup count, combined size, and how full that storage is
- PBS backups now show their **encryption status** (`Encrypted` / `Not encrypted`) and **verification state** (`Verified` / `Verify failed` / `Not verified`) as status tags on each backup
- **Protected** backups are flagged, and backup **notes** are shown inline

## 2026-07-06 — SSH keys auto-derive their public key (and warn when they can't)

- Adding an SSH key now **derives the public key from the private key** automatically when you don't paste one — so the key is immediately usable for cloud-init provisioning (which injects the public key into the guest). Works for OpenSSH, PEM, and PuTTY PPK keys, including encrypted keys when you supply the passphrase.
- If a public key still can't be produced (e.g. an encrypted key added without its passphrase), the **Add Key** dialog now clearly warns that the key won't work for deploying VMs, instead of failing silently later.
- The SSH Keys list flags any key with **No public key** so incomplete keys are obvious at a glance.
- Existing keys missing a public key are **backfilled** automatically (for unencrypted keys) the next time the list loads — no need to re-add them.

## 2026-07-06 — Deploy VMs directly from cloud images, with live progress

### Cloud image as the provisioning source
- New **Cloud Image** tab on the New VM page: pick a downloaded cloud image (Ubuntu, Debian, Rocky, or any custom qcow2/raw) and deploy a brand-new VM straight from it — no static Proxmox template needed
- The backend builds the VM directly with `import-from`: creates the VM shell, imports the image as the boot disk, grows the disk, attaches a cloud-init drive and serial console, applies the cloud-init user/password/SSH keys/network, stamps owner + VLAN tags, and can start the VM when it's done
- The cloud image catalog is now the source of truth for provisioning — updating a base image means re-downloading it, not rebuilding a template
- Cloud-init settings (guest user, password, your stored SSH keys, DHCP/static network) work in the direct flow just like the template clone flow; capacity (node memory + storage space) and CPU-topology checks run before anything is created
- Available to any user with provisioning permission; admins additionally pick the target network bridge and can assign the VM to another user
- Template cloning and create-from-scratch are unchanged and still available — templates become an optional fast-clone path rather than the only way to use a cloud image

### Live deployment progress
- Every deploy (cloud image, template clone, or from scratch) now shows a **step-by-step progress stepper** with a progress bar instead of a blank "creating…" wait: reserving VMID, checking capacity, creating/importing, resizing, applying cloud-init, tagging, and starting
- Failed Proxmox tasks surface the error inline, and partial issues (e.g. a disk resize that couldn't run) show as a warning with detail
- The Recent Provisions table now shows the source image or template per job
- New audit action `vm_from_image` for direct cloud-image deployments

## 2026-07-06 — Cloud image provisioning with cloud-init

### Cloud image catalog (admins)
- New **Cloud Images** section on the Templates page: download official cloud images (Ubuntu, Debian, Rocky, or any custom qcow2/raw URL) straight onto a PVE storage via the Proxmox API — presets included, optional SHA256 verification
- Images are stored as **import content**, so the download-target storage needs the "Import" content type enabled (Datacenter → Storage → local → Content); PVE 9 rejects the old ISO-storage import trick
- **Create Template** turns a downloaded image into a ready-to-clone cloud-init template in one click: imports the image as the boot disk (`import-from`), attaches a cloud-init drive and serial console, grows the disk to a chosen base size, converts the VM to a Proxmox template, and registers it in the portal's template list
- Download and template builds run in the background with live status in the table; actions are audit-logged (`cloud_image_download`, `cloud_image_template`, `cloud_image_delete`)

### Cloud-init provisioning (users)
- Cloning a cloud-init template now offers a **Cloud-Init Setup** section: guest username, optional password, your stored SSH public keys (checkbox per key), and network mode — DHCP or static IP/gateway
- Settings are applied on the VM's first boot via cloud-init; no ISO installer, no manual account setup
- Server-side validation of username/password/IP formats; SSH keys are read from your own stored keys only

## 2026-07-06 — Proxmox owner/VLAN tags on VMs, provisioning capacity rails

### Owner + VLAN tags in the Proxmox UI
- VMs are now tagged in Proxmox with the assigned owner's username and the VLAN of each tagged network interface (`vlan-<name>`, or `vlan-<number>` for VLANs the portal doesn't know), so ownership and network placement are visible as tag pills directly in the PVE UI
- Tags update automatically when a VM is assigned or unassigned, when a user is renamed or deleted (the old username tag is stripped), and when provisioning completes
- New "Sync PVE Tags" button on the Assignments page re-stamps every VM at once — use it once after deploying to tag the existing fleet, or after changing NIC VLANs outside the portal (audit-logged as `vm_tags_sync`)
- The portal only manages its own tag namespaces (portal usernames and `vlan-*`); any other manually set PVE tags are left untouched

### Provisioning capacity rails
- Cloning and creating a VM now checks the target node's **free memory** and the target storage's **available disk space** before any Proxmox task starts; requests that don't fit are rejected with a clear message (e.g. "requested 16.0 GB, only 12.3 GB free")
- The checks fail open if the Proxmox API can't be queried, so a monitoring hiccup never blocks provisioning — real API failures still surface from the clone/create call itself

## 2026-07-06 — VNC clipboard paste, grid-lines-over-buttons fix, 2FA safety rails

### Paste into VNC consoles
- Both VNC surfaces (pop-out console tab and floating console windows) now have a **Paste** button that types your clipboard into the VM as keystrokes
- Works on any guest with no agent installed — including login prompts, TTYs, and installers — because it replays the text as key events instead of relying on a guest clipboard channel (which QEMU only supports with spice-vdagent)
- Reads the browser clipboard where permitted (asks once); browsers that block clipboard access fall back to a paste-in prompt
- Newlines and tabs are sent as Enter/Tab; typing is paced (~100 chars/s) so slow guests don't drop keys; pastes over 2,000 characters ask for confirmation first
- SSH consoles are unaffected — they already support native browser paste via the terminal

### Background grid fix
- The AARIS background grid no longer draws on top of buttons and other content — it was rendering at `z-index: 0`, which paints over non-positioned elements, slicing dark 48px grid lines across the orange action buttons
- The grid now sits behind all content (`z-index: -1`); opaque panels mask it and it shows through open page space as intended
- Same fix applied to the reusable `aaris.css` base and the code sample in `aaris-design-language.md`

### Two-factor authentication safety rails
- `POST /auth/2fa/setup` now refuses to run while 2FA is already enabled — previously a single call silently disabled the active second factor even if the new enrollment was never completed
- The admin "Disable 2FA for this user" button now asks for confirmation before firing (it was the only destructive action without one)
- Self-service 2FA changes are now audit-logged (`2fa_setup_started`, `2fa_enabled`, `2fa_disabled`) so silent state flips are traceable in the audit log

## 2026-07-05 — Discord status uplink in the sidebar

### Discord community link
- Added a "Discord / Status" uplink row to the sidebar footer for all signed-in users
- Join the Discord to get status updates and be notified about maintenance windows and breakdowns
- Styled as an AARIS uplink row (mono uppercase, bordered, orange hover) with the Discord mark; opens in a new tab

## 2026-07-05 — Changelog visible to all users

### Changelog access
- The changelog panel in the sidebar is now visible to every signed-in user, not just admins
- Renamed the component from `AdminChangelogPanel` to `ChangelogPanel` and dropped the "Admin Changelog" labelling
- Restyled the panel to the AARIS design language (square panels, mono uppercase labels, orange markers)

## 2026-07-05 — VM deletion, human console tab names, and AARIS design language

### VM deletion with backup purge
- Added a "Delete" button to the VM detail page action bar with a type-the-VM-name confirmation modal
- Admins can delete any VM; regular users can only delete VMs assigned to them — the `see_all_vms` flag deliberately does **not** grant deletion rights (new strict `userOwnsVm` ownership check, separate from the view-access check)
- Deletion force-stops a running guest, waits for it to stop, destroys the VM/LXC with `purge=1` and `destroy-unreferenced-disks=1`, and waits for the Proxmox task to finish before reporting success
- **All backups of the deleted VMID are purged across every backup-capable storage on the host**, so a future VM that reuses the ID no longer inherits the old VM's backups (fixes the reported issue of new VMs seeing restore points from previously deleted VMs)
- Portal records tied to the VM (`vm_assignments`, `vm_ssh_configs`, `vm_ssh_user_configs`, `provisioned_vms`) are cleaned up in the same operation
- Backups that fail to delete are reported back to the UI and logged; deletions are audit-logged as `vm_delete` with the backup count
- New backend endpoint: `DELETE /vms/:node/:vmid`

### Human-readable console tab names
- Popped-out VNC/SSH browser tabs are now titled with the VM name (e.g. `SSH - webserver01`) instead of the Proxmox VMID
- The opener passes the name via a `?name=` query param for an instant title; the page then confirms it from the status API, so direct URL navigation also resolves the real name (new `useVmName` hook)
- The VNC/SSH page toolbars now lead with the VM name, with node/VMID as secondary mono metadata

### AARIS design language (2026 frontend refresh)
- The frontend now follows the AARIS operator-console design language documented in `aaris-design-language.md` / `aaris.css`: dark near-black surfaces, square machined corners, thin borders instead of shadows, orange as the single action accent, Archivo headings + IBM Plex Mono labels
- Tailwind theme remap: all stock color families fold onto the AARIS palette (neutrals → cool near-black ramp, all action hues → orange accent, green/amber/red reserved for status), every border radius flattened to 0 (except `rounded-full` for genuinely round elements), all box shadows disabled
- Global styles: background technical grid, orange selection/focus-visible states, AARIS scrollbars, square LED helpers (`aaris-led`), heavy uppercase display headings (`aaris-display`), `prefers-reduced-motion` support
- Login rebuilt as an identity-plate + numbered-section console form; sidebar nav converted to mono uppercase labels with an orange active rail and LED user status
- Status badges are now square bordered mono tags with square LEDs; VM cards use a solid status strip (no gradients), square meter bars, and mono metadata
- Floating console windows and the console dock are solid machined panels (no glassmorphism/translucency)
- Page and section headings across the app (Dashboard, VM detail, admin pages) use the uppercase display style, with the numbered-section pattern on the dashboard
- Performance charts and the SSH terminal recolored to AARIS tokens (orange/amber/green/neutrals); terminal theme uses the near-black input surface with an orange cursor
- Removed remaining gradient strips, backdrop-blur glass, decorative shadows, and hard-coded off-palette hex colors (the network topology diagram on the Policies page keeps its categorical service colors, since those are data-bearing)

### Custom port-forward naming
- New custom port forwards now include the internal service port and protocol in the generated VIP/policy name, for example `Minecraft - Custom 25565/tcp`
- Root and lab VDOM firewall policies inherit that generated name through the existing `PF: ...` policy naming pattern
- This allows multiple custom forwards for the same VM as long as they target different internal ports/protocols

### Duplicate protection
- The backend now rejects duplicate managed forwards for the same firewall, internal IP, internal port, and protocol
- The existing external port/protocol conflict check remains in place, so the same WAN port cannot be reused on the firewall
- Port/protocol values are normalized and validated server-side before FortiGate objects are created

### Compatibility
- Existing managed VIPs and policies keep their old names; no migration or FortiGate rename is performed
- Old records such as `VM - Custom` continue to be matched, listed, deleted, and VLAN-cleaned by their stored `vip_name` and `service_name`
- New duplicate checks include old database rows, so an old `VM - Custom` rule still prevents creating another managed forward to the same internal IP/port/protocol

## 2026-04-15 — VNC reliability and SSH UTF-8 fixes

### VNC console connection reliability
- Fixed frequent "Connection lost" errors when opening VNC consoles, especially on cold page loads
- Root cause: `await import('@novnc/novnc/lib/rfb.js')` was issued **after** the VNC ticket was obtained from Proxmox, so the 308 KB noVNC bundle download/parse delay (up to 10+ seconds on first load) often exceeded the Proxmox VNC proxy's short-lived listener window, leaving the server-side proxy to time out before the WebSocket was opened
- Fix: the noVNC RFB module is now preloaded at module evaluation time and the dynamic `import()` is awaited **before** the VNC ticket is requested, so the Proxmox VNC proxy is only started when we're ready to connect to it immediately
- Applies to both the docked `VNCSessionPanel` and the standalone `/vnc/:node/:vmid` page
- Added backend logging around VNC ticket creation and the Proxmox websocket upgrade (`[VNC-ticket]`, `[VNC-ws]`, `[WS-upgrade]`) including Proxmox's HTTP response body on rejection, to aid future troubleshooting

### SSH terminal UTF-8 rendering
- Fixed garbled output in the SSH terminal for any command that emits multi-byte UTF-8 (Docker Compose progress spinners, checkmarks, box-drawing chars, non-ASCII paths, etc.) — previously showed sequences like `â` and stray control chars
- Root cause: the frontend decoded base64 shell data with `atob(...)` and passed the resulting binary string straight to xterm's `term.write`, which interprets each character as a Unicode code point instead of a UTF-8 byte, shredding any byte above 0x7F
- Fix: the frontend now materializes the decoded base64 into a `Uint8Array` before calling `term.write`, so xterm parses the stream as UTF-8 and renders spinners/progress updates correctly

## 2026-04-02 — VM hardware editing with permission control

### CPU, memory, and disk editing
- Added "Hardware" button on the VM detail page action bar that opens a two-tab modal for editing CPU cores, memory, and disk size
- CPU & Memory tab: number inputs for cores (1–128) and memory (128 MB–1 TB), quick memory presets (512M–32G), running-VM warning banner
- Disk Resize tab: disk selector dropdown with current size/storage info, incremental expand-by-GB input
- CPU core changes use the same topology computation as VM provisioning — requested cores are validated against physical host core count and mapped to an optimal sockets×cores layout

### Permission gating
- Added `can_edit_vm_hardware` per-user permission flag (toggleable in admin Users page under "Edit VM Hardware")
- Hardware button only appears for admins or users with the permission enabled
- Backend endpoints (`PUT /vms/:node/:vmid/hardware` and `PUT /vms/:node/:vmid/resize-disk`) enforce the permission via `requirePermission` middleware
- All hardware changes are audit-logged with details of what was changed

### Backend changes
- Extracted `computeCpuTopology(node, requestedCores)` into shared `backend/src/utils/cpuTopology.js` utility, used by both provisioning and hardware editing
- Added `resizeVMDisk` Proxmox API wrapper for the `PUT /nodes/:node/qemu/:vmid/resize` endpoint

## 2026-04-01 — Console tiling, pop-out tabs, and SFTP file browser

### Console window tiling
- Added tiling layout controls to the console dock that appear when 2+ console windows are open
- Three tiling modes: Auto Grid (columns/rows based on window count), Side by Side (horizontal), and Stacked (vertical)
- Tiling is a one-shot rearrangement — windows remain freely draggable after tiling
- Layout respects sidebar offset, top bar, and dock reserve area

### Pop-out to new tab
- Added a pop-out button to every floating console window title bar (between minimize and close)
- VNC sessions pop out to the existing standalone `/vnc/:node/:vmid` page
- SSH sessions pop out to a new standalone `/ssh/:node/:vmid` page with fullscreen support
- Added "SSH Tab" button on the VM detail page alongside the existing "VNC Tab" button
- Pop-out opens a fresh session in the new tab and closes the floating window

### SFTP file browser
- Added in-browser file upload and download via SFTP, accessible from the "Files" tab in any connected SSH session
- Backend SFTP routes use the ssh2 library's SFTP subsystem with the same SSH credentials and host key verification as terminal sessions
- File browser features: breadcrumb navigation, directory listing with sort (folders first), file download, file upload (button or drag-and-drop), new folder creation, and file/folder deletion with confirmation
- SFTP sessions use REST endpoints (not WebSocket) — each operation opens a fresh authenticated SSH+SFTP connection
- Upload limit: 100 MB per file; SFTP tokens auto-extend on activity (30-minute idle expiry)
- Extracted SSH connection form into reusable `SSHConnectForm` component shared between terminal and SFTP flows
- Added shared `sshConnect.js` backend utility for creating authenticated SSH connections with host key verification

## 2026-03-28 — Provisioned VMs now use CPU type host

### Provisioning CPU model default
- New VMs created through the admin create-from-scratch flow now explicitly set the Proxmox CPU type to `host`
- Cloned VMs now also enforce `cpu=host` during the post-clone configuration pass, alongside the existing CPU topology updates
- This keeps newly provisioned VMs aligned with the physical host CPU model regardless of whether they were cloned from a template or created directly

## 2026-03-26 — VM IP management and DHCP reservations

### VM-side IP visibility
- Added VM IP management to the VM details page so each network interface now shows the detected MAC address, VLAN tag, firewall DHCP scope, current lease, and current reserved IP
- The backend now matches VM NICs to FortiGate DHCP data by combining the VM's MAC address with the VLAN-backed firewall interface, instead of relying on a separately maintained IP field
- Tagged-only or unsynced VLANs now explain why managed DHCP/IP control is unavailable for that interface

### DHCP reservation management
- Added FortiGate-backed DHCP reservation create, update, and delete support for VM interfaces on managed VLANs
- Reservation edits now work directly against the synced FortiGate DHCP server's `reserved-address` table and also read the live lease table from `monitor/system/dhcp`
- Saving a reservation automatically updates the VM's SSH host target in the portal when an SSH config already exists, so changing the reserved IP also updates the expected SSH destination

## 2026-03-25 — VNC proxy nodeRef compatibility fix

### Host-aware VNC proxying
- Fixed the backend VNC websocket proxy so host-aware `nodeRef` values like `2~pve02` are translated back to the real Proxmox node name before opening the upstream `/vncwebsocket` connection
- This restores VNC console connectivity for the docked multi-session console flow after the multi-host `nodeRef` rollout

## 2026-03-25 — Multi-session SSH and VNC console dock

### Shared console manager
- SSH and VNC consoles now open through a shared app-level session manager instead of one-page-only modals
- Multiple SSH and VNC sessions can stay open at the same time, each with its own live websocket or RFB connection
- Console sessions persist while you move around the UI and can be restored without reconnecting after being minimized

### Docked console workflow
- Console windows can now be minimized into a bottom-left `Console Dock` and restored individually later
- Each console window gets its own floating header with minimize and close controls, so you can keep several sessions running side by side
- SSH and VNC modal wrappers now reuse the same panel components as the docked session windows, so console behavior stays consistent everywhere

## 2026-03-24 — Dedicated port forwarding permission

### New user permission
- Added a dedicated `can_manage_port_forwards` user permission so admins can grant scoped port-forward access without also granting full firewall-management rights
- The new permission is exposed through `/auth/me`, the admin user list, and the user permission editor in the UI
- Admin routing and sidebar navigation now recognize the dedicated port-forward permission as its own admin-area capability

## 2026-03-24 — Scoped port forwarding access

### Policy-style access scoping for port forwarding
- Users who reach the port forwarding page through delegated networking permissions are now scoped the same way as the policy manager instead of getting full firewall-wide visibility
- Scoped users only see port-forward target VMs that they already have VM access to **and** that sit on VLANs assigned to them through `user_vlans`
- Scoped users only see managed port forwards that belong to their own VLAN interfaces; unmanaged/external VIPs and other users' managed forwards are hidden
- Scoped users can only create port forwards for their own VM targets on their own synced VLANs, and the backend now derives the allowed internal IP/interface from the selected VM instead of trusting freeform client input
- Scoped users can only delete managed port forwards tied to VLAN interfaces they own; firewall admins and full admins keep unrestricted visibility/edit access

### UI alignment
- The Port Forwarding page now works for policy-scoped users without requesting root-interface data they are not allowed to manage
- WAN config editing remains reserved for firewall admins, while scoped users get a read-only view and a clearer message when WAN configuration is missing
- The sidebar now shows `Port Forwarding` for users with either firewall-management or policy-management access

## 2026-03-24 — Multi-host VM identity and provisioning correctness pass

### Host-aware VM identity across the UI and API
- Added a canonical host-aware `nodeRef` format (`{hostId}~{node}`) so VM actions, assignments, SSH config, VNC, VLAN changes, template selection, and port-forward target selection no longer rely on plain node names alone
- Proxmox wrappers now resolve nodes by host-aware reference and stop falling back to the first configured host when a node name is ambiguous across multiple Proxmox endpoints
- Dashboard, VM details, admin assignments, user VM assignment management, provisioning forms, template registration, and port forwarding now route requests with the stable `nodeRef` while still showing the human-readable node name in the UI
- Legacy plain-node rows remain readable for compatibility, but exact host-aware matches are now preferred everywhere

### Provisioning correctness improvements
- CPU topology calculation now preserves the requested vCPU count instead of over-allocating cores when the requested total does not divide cleanly into the old fixed socket layout
- Global VMID allocation now refuses to hand out a “globally unique” VMID while any configured Proxmox host is unreachable, instead of silently skipping failed hosts and risking a duplicate VMID
- Clone/create tracking now records `status_detail`, and post-clone configuration failures no longer lie with a `ready` state when disk resize, VLAN tagging, or later config steps fail
- Provisioning status responses now carry both display node names and `nodeRef`, and the Recent Provisions UI now highlights warning states and shows the backend warning detail directly

### Admin session + lookup cleanup
- Admin role state is refreshed from the database on each authenticated request, so demoting an admin takes effect on active sessions without waiting for logout
- Port-forward VM target discovery now reuses the normal Proxmox config helper instead of dynamic per-row imports, and it only falls back to legacy plain-node SSH configs when the VM identity is unambiguous
- Added a short-lived VM config cache in the Proxmox client so hot admin screens do not repeatedly hammer the same VM config endpoints

## 2026-03-24 — Port forwarding policy specificity fix

### Correct service and destination matching
- Managed port forward service objects now use the mapped internal port instead of the external WAN-facing port, so a forward like `2222 -> 22` generates `TCP/22` policy objects instead of `TCP/2222`
- The lab VDOM policy for a managed port forward is no longer created as broad `all -> all / ALL`
- Lab-side rules now target a managed host address object for the mapped internal IP and use the same exact per-forward service object as the root VDOM policy

### Cleanup updates
- Deleting a managed port forward now also removes the lab VDOM service object and the managed lab-side destination address object
- VLAN deletion cleanup now removes both root and lab port-forward objects before deprovisioning the VLAN itself

## 2026-03-24 — Object-based port forwarding

### VLAN deletion now cleans up port forwards
- Deleting a VLAN now first removes all port forwards targeting that VLAN's interface before deprovisioning the VLAN itself
- For each port forward: root VDOM policy, VIP, and service object are deleted; the lab VDOM policy is swept by `deprovisionVlan`'s policy search
- `managed_vips` DB records are removed so no orphaned entries remain
- Port forward cleanup is best-effort per item — if one fails, the rest still proceed and the DB record is still removed
- Order: port forwards first → VLAN deprovision (interface, address object, DHCP, routes, policies, switch) → DB delete (CASCADE removes `user_vlans` and `firewall_vlan_sync`)

### Dual-VDOM port forwarding with sequence grouping
- Port forwards now create **two** firewall policies: one in the root VDOM (WAN → inter-VDOM link) and one in the lab VDOM (inter-VDOM link → VLAN interface)
- The lab VDOM policy is placed in the correct sequence group using `global-label: Port Forwarding (vlanXXXX)` and moved next to existing policies in that group
- Destination interface for the root VDOM policy uses `root_vdom_link` (e.g. `lab-root1`) instead of the VLAN interface name, which only exists in the lab VDOM
- Lab VDOM policy source interface uses `lab_vdom_link` (e.g. `lab-root0`)
- Both policy IDs are tracked in `managed_vips` (`policy_id` + `lab_policy_id`) for clean deletion
- Delete cleans up both VDOM policies, the VIP, and the service object
- New `movePolicy` method in FortiGate API wrapper for policy reordering
- Rollback on creation failure also cleans up the lab VDOM policy

### Port forwarding redesign
- The create form is now VM-centric: pick a target VM, pick a service, set the external port — everything else is auto-resolved
- VM dropdown is populated from VMs that have SSH configs (which means they have a known internal IP)
- Service presets (SSH, HTTP, HTTPS, RDP) auto-fill internal port and protocol; "Custom" allows free entry of port and protocol
- Internal IP is auto-filled from the VM's SSH config; destination interface is auto-resolved from the VM's VLAN tag via the `firewall_vlan_sync` table
- Rule name is auto-generated as `{VM name} - {Service}` but remains editable
- If the VLAN→interface mapping can't be resolved (VM not on a synced VLAN), a manual interface picker falls back
- New backend endpoint `GET /admin/firewalls/:id/vm-targets` returns all VMs with SSH IPs and VLAN-to-interface mappings
- Removed source address restriction from the create form (always `all`) — this was rarely used and added complexity
- VIP table, WAN config, managed/external badges, port conflict detection, and delete flow are unchanged

## 2026-03-23 — Scoped VLAN management for delegated users

### Rebuilt template registration form
- The "Add Template" modal now lists all qemu VMs on the selected node — both Proxmox templates and regular VMs — fixing the bug where the source VM picker was empty (the old code fetched from a non-existent `/admin/vms` endpoint)
- Selecting a source VM auto-populates defaults (cores, memory, disk, storage, cloud-init) by reading the VM's actual Proxmox config — no more guessing at values
- New backend routes: `GET /provision/admin/pve-vms/:node` lists all qemu VMs, `GET /provision/admin/pve-vms/:node/:vmid/config` returns parsed VM config with computed defaults
- VMs in the dropdown are grouped into "Proxmox Templates" and "Regular VMs" with status shown for stopped VMs
- Memory field now uses GB (matching the provisioning forms) and converts to MB for storage
- Edit mode also uses GB for the memory field

### Memory input in GB
- Provisioning forms (clone and create) now accept memory in GB instead of MB — e.g. entering `32` gives the VM 32768 MiB
- Backend converts GB → MiB (`Math.round(gb * 1024)`) before passing to the Proxmox API
- Template defaults are stored in MB in the database and auto-converted to GB for display
- Supports half-GB increments (0.5 GB step) for fine-grained sizing

### Globally unique VMIDs across all hosts
- `getNextVmid()` now collects all used VMIDs from every connected Proxmox host before picking the next free ID
- Previously it asked a single host for `/cluster/nextid`, which only checked within that host's cluster — causing VMID collisions when provisioning across independent hosts (e.g. VM 101 on pve01 → pve02 also tries 101)
- The new logic scans all hosts' `/cluster/resources?type=vm`, builds a global set of used IDs, and picks the lowest free VMID starting at 100

### Automatic CPU topology matching
- VMs are now created with 2 sockets and cores spread evenly across them, matching the physical host's socket layout
- The max cores per socket is capped at the host's actual cores-per-socket (fetched from `/nodes/{node}/status` at provision time)
- This is fully transparent — users/admins still just pick a total core count, and the backend computes the optimal `sockets × cores` split
- Example: requesting 8 cores on a 2×12 host → VM gets `sockets=2, cores=4`
- Clone route validates the CPU count against the target node *before* starting the clone, returning an immediate 400 error if the request exceeds physical cores
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
