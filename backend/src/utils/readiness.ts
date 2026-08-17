// Portal readiness / prerequisite evaluation — PURE.
//
// Homelabrrr's features sit on top of chains of prior setup (a PVE host → an
// exposed storage → a template; a firewall → an external IP → a synced VLAN;
// a Caddy server → a WAN IP). Those dependencies used to be invisible until a
// user hit a wall, so this module turns them into an explicit, readable list.
//
// Everything here takes ALREADY-FETCHED plain data — host rows plus the result
// of getHostStatus, firewall rows, storage-visibility counts, template/image
// counts, and which env vars are set — and returns the check array the admin
// "Setup status" card renders. No DB handle, no network, no Express req/res:
// the caller owns all the I/O and all the fault tolerance, which is what makes
// one unreachable Proxmox host unable to take the whole endpoint down.
//
// Every check is `{ id, label, status: 'ok'|'warn'|'missing', detail, href }`.
//   ok      — the prerequisite is satisfied.
//   warn    — degraded, or an optional subsystem is not set up at all, so the
//             feature it powers is simply unavailable.
//   missing — something is registered but incomplete, and a feature that is
//             meant to work is broken until it is fixed.
//
// Checks that only exist downstream of a failed prerequisite are omitted rather
// than repeated (no host registered ⇒ no point reporting "tokens invalid" and
// "no storage exposed" as two more red rows). Independent optional subsystems
// (firewall, reverse proxy) always get a row, because their absence is itself
// information an admin wants on the overview.

export const READINESS_STATUSES = ['ok', 'warn', 'missing'];

const HREF_HOSTS = '/admin/hosts';
const HREF_FIREWALLS = '/admin/firewalls';
const HREF_VLANS = '/admin/vlans';
const HREF_TEMPLATES = '/admin/templates';
const HREF_WEBSITES = '/admin/websites';

/** Sort key so the UI can put the actionable rows first without re-deriving it. */
export function readinessSeverity(status) {
  if (status === 'missing') return 2;
  if (status === 'warn') return 1;
  return 0;
}

/**
 * Classify why a getHostStatus() call came back offline. Proxmox rejects a bad
 * or expired API token with an HTTP 401/403, which makeRequest surfaces as
 * "Proxmox GET /version → 401: ...", so an invalid token is distinguishable
 * from a host that is simply down or firewalled off.
 *
 * @returns {'auth'|'tls'|'unreachable'}
 */
export function classifyHostFailure(message) {
  const text = String(message || '');
  if (/→\s*40[13]\b/.test(text)) return 'auth';
  if (/authentication failure|no ticket|permission check failed|invalid token/i.test(text)) return 'auth';
  if (/TLS verification is disabled|self[- ]signed|certificate/i.test(text)) return 'tls';
  return 'unreachable';
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function nameList(items, max = 3) {
  const names = items.map((i) => i.name || `#${i.id}`);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

function statusForHost(hostStatuses, hostId) {
  const row = (hostStatuses || []).find((s) => String(s.hostId) === String(hostId));
  return row || { hostId, online: false, error: 'No status was collected for this host' };
}

function storageForHost(hostStorages, hostId) {
  const row = (hostStorages || []).find((s) => String(s.hostId) === String(hostId));
  return row || { hostId, total: 0, exposed: 0, error: 'No storage list was collected for this host' };
}

// ── Individual checks ────────────────────────────────────────────────────────

function checkPveHosts({ hosts, hostStatuses }) {
  if (hosts.length === 0) {
    return {
      id: 'pve_hosts',
      label: 'Proxmox host registered',
      status: 'missing',
      detail: 'No Proxmox host is registered. The portal cannot list, create, or open a console on any VM until one is added under PVE Hosts.',
      href: HREF_HOSTS,
    };
  }
  const offline = hosts.filter((h) => !statusForHost(hostStatuses, h.id).online);
  if (offline.length === hosts.length) {
    return {
      id: 'pve_hosts',
      label: 'Proxmox host reachable',
      status: 'missing',
      detail: `All ${hosts.length} registered ${plural(hosts.length, 'host is', 'hosts are')} unreachable (${nameList(offline)}). Nothing that touches a VM will work.`,
      href: HREF_HOSTS,
    };
  }
  if (offline.length > 0) {
    return {
      id: 'pve_hosts',
      label: 'Proxmox host reachable',
      status: 'warn',
      detail: `${offline.length} of ${hosts.length} hosts unreachable (${nameList(offline)}). VMs on ${plural(offline.length, 'it', 'them')} are invisible to the portal.`,
      href: HREF_HOSTS,
    };
  }
  return {
    id: 'pve_hosts',
    label: 'Proxmox host reachable',
    status: 'ok',
    detail: `${hosts.length} ${plural(hosts.length, 'host', 'hosts')} registered and reachable.`,
    href: HREF_HOSTS,
  };
}

function checkPveTokens({ hosts, hostStatuses }) {
  const failures = hosts
    .map((h) => ({ host: h, status: statusForHost(hostStatuses, h.id) }))
    .filter((x) => !x.status.online)
    .map((x) => ({ ...x, kind: classifyHostFailure(x.status.error) }));

  const badToken = failures.filter((f) => f.kind === 'auth').map((f) => f.host);
  const badTls = failures.filter((f) => f.kind === 'tls').map((f) => f.host);

  if (badToken.length > 0) {
    return {
      id: 'pve_tokens',
      label: 'Proxmox API tokens valid',
      status: 'missing',
      detail: `Proxmox rejected the API token for ${nameList(badToken)}. Re-issue the token in Proxmox and update the host.`,
      href: HREF_HOSTS,
    };
  }
  if (badTls.length > 0) {
    return {
      id: 'pve_tokens',
      label: 'Proxmox API tokens valid',
      status: 'warn',
      detail: `TLS to ${nameList(badTls)} failed, so the token could not be validated. Fix the certificate or the host's TLS setting.`,
      href: HREF_HOSTS,
    };
  }
  if (failures.length > 0) {
    return {
      id: 'pve_tokens',
      label: 'Proxmox API tokens valid',
      status: 'warn',
      detail: `${nameList(failures.map((f) => f.host))} could not be reached, so ${plural(failures.length, 'its token was', 'those tokens were')} not validated.`,
      href: HREF_HOSTS,
    };
  }
  return {
    id: 'pve_tokens',
    label: 'Proxmox API tokens valid',
    status: 'ok',
    detail: `Every registered host answered an authenticated API call.`,
    href: HREF_HOSTS,
  };
}

function checkStorageExposed({ hosts, hostStatuses, hostStorages }) {
  const reachable = hosts.filter((h) => statusForHost(hostStatuses, h.id).online);
  if (reachable.length === 0) {
    return {
      id: 'storage_exposed',
      label: 'Storage exposed to users',
      status: 'warn',
      detail: 'No reachable host, so the storage pools users may pick from could not be listed.',
      href: HREF_HOSTS,
    };
  }

  const unreadable = [];
  const noPools = [];
  const allHidden = [];
  for (const host of reachable) {
    const row = storageForHost(hostStorages, host.id);
    if (row.error) { unreadable.push(host); continue; }
    if (!row.total) { noPools.push(host); continue; }
    if (!row.exposed) allHidden.push(host);
  }

  if (allHidden.length > 0) {
    return {
      id: 'storage_exposed',
      label: 'Storage exposed to users',
      status: 'missing',
      detail: `Every storage pool is hidden from users on ${nameList(allHidden)}. Non-admins cannot create a VM or add a disk there — expose at least one pool.`,
      href: HREF_HOSTS,
    };
  }
  if (noPools.length > 0) {
    return {
      id: 'storage_exposed',
      label: 'Storage exposed to users',
      status: 'missing',
      detail: `${nameList(noPools)} reports no storage pools at all. Check the token's permissions on /storage.`,
      href: HREF_HOSTS,
    };
  }
  if (unreadable.length > 0) {
    return {
      id: 'storage_exposed',
      label: 'Storage exposed to users',
      status: 'warn',
      detail: `The storage list could not be read from ${nameList(unreadable)}.`,
      href: HREF_HOSTS,
    };
  }
  return {
    id: 'storage_exposed',
    label: 'Storage exposed to users',
    status: 'ok',
    detail: `Every reachable host exposes at least one storage pool to non-admins.`,
    href: HREF_HOSTS,
  };
}

function checkProvisionSources({ templateCount, cloudImageCount, provisionUserCount }) {
  const total = (templateCount || 0) + (cloudImageCount || 0);
  if (!provisionUserCount) {
    return {
      id: 'provision_sources',
      label: 'Deployable template or cloud image',
      status: 'ok',
      detail: 'Nobody holds provisioning access, so no deploy source is needed yet.',
      href: HREF_TEMPLATES,
    };
  }
  if (total === 0) {
    return {
      id: 'provision_sources',
      label: 'Deployable template or cloud image',
      status: 'missing',
      detail: `${provisionUserCount} ${plural(provisionUserCount, 'user has', 'users have')} provisioning access but there is no enabled template and no ready cloud image. The New VM page is empty for them.`,
      href: HREF_TEMPLATES,
    };
  }
  return {
    id: 'provision_sources',
    label: 'Deployable template or cloud image',
    status: 'ok',
    detail: `${templateCount || 0} enabled ${plural(templateCount || 0, 'template', 'templates')} and ${cloudImageCount || 0} ready cloud ${plural(cloudImageCount || 0, 'image', 'images')} available.`,
    href: HREF_TEMPLATES,
  };
}

function checkFirewallExternalIp({ firewalls }) {
  if (firewalls.length === 0) {
    return {
      id: 'firewall_external_ip',
      label: 'Firewall external IP',
      status: 'warn',
      detail: 'No firewall is registered, so port forwarding and VLAN automation are unavailable. Optional — skip this if the lab has no FortiGate.',
      href: HREF_FIREWALLS,
    };
  }
  const missing = firewalls.filter((f) => !String(f.externalIp || '').trim());
  if (missing.length > 0) {
    return {
      id: 'firewall_external_ip',
      label: 'Firewall external IP',
      status: 'missing',
      detail: `${nameList(missing)} ${plural(missing.length, 'has', 'have')} no external IP set. Port forwarding cannot create a VIP without the public address.`,
      href: HREF_FIREWALLS,
    };
  }
  return {
    id: 'firewall_external_ip',
    label: 'Firewall external IP',
    status: 'ok',
    detail: `Every registered firewall has a public IP set for VIPs.`,
    href: HREF_FIREWALLS,
  };
}

function checkFirewallVlanSync({ firewalls, vlanSyncCounts }) {
  const countFor = (id) => {
    const row = (vlanSyncCounts || []).find((c) => String(c.firewallId) === String(id));
    return row ? row.count || 0 : 0;
  };
  const unsynced = firewalls.filter((f) => countFor(f.id) === 0);
  if (unsynced.length === firewalls.length) {
    return {
      id: 'firewall_vlan_sync',
      label: 'VLAN synced to a firewall',
      status: 'missing',
      detail: 'No VLAN is synced to any firewall. A VM must sit on a synced VLAN before a port forward can point at it.',
      href: HREF_VLANS,
    };
  }
  if (unsynced.length > 0) {
    return {
      id: 'firewall_vlan_sync',
      label: 'VLAN synced to a firewall',
      status: 'warn',
      detail: `${nameList(unsynced)} ${plural(unsynced.length, 'has', 'have')} no synced VLAN, so nothing can be forwarded through ${plural(unsynced.length, 'it', 'them')}.`,
      href: HREF_VLANS,
    };
  }
  return {
    id: 'firewall_vlan_sync',
    label: 'VLAN synced to a firewall',
    status: 'ok',
    detail: `Every registered firewall has at least one synced VLAN.`,
    href: HREF_VLANS,
  };
}

function checkCaddyWanIp({ caddyServers, siteCount }) {
  if (caddyServers.length === 0) {
    return {
      id: 'caddy_wan_ip',
      label: 'Reverse proxy WAN IP',
      status: 'warn',
      detail: 'No Caddy server is registered, so website publishing is unavailable. Optional — skip this if the lab publishes nothing.',
      href: HREF_WEBSITES,
    };
  }
  const noIp = caddyServers.filter((s) => !String(s.wanIp || '').trim());
  if (noIp.length > 0) {
    return {
      id: 'caddy_wan_ip',
      label: 'Reverse proxy WAN IP',
      status: siteCount > 0 ? 'missing' : 'warn',
      detail: `${nameList(noIp)} ${plural(noIp.length, 'has', 'have')} no WAN IP — set one, or link a FortiGate with an external IP. Without it the DNS pre-check cannot tell a user where to point their A record.`,
      href: HREF_WEBSITES,
    };
  }
  return {
    id: 'caddy_wan_ip',
    label: 'Reverse proxy WAN IP',
    status: 'ok',
    detail: `Every registered reverse proxy resolves to a WAN IP.`,
    href: HREF_WEBSITES,
  };
}

function checkSecrets({ env }) {
  const missing = [];
  if (!env.secretEncryptionKey) missing.push('SECRET_ENCRYPTION_KEY');
  if (!env.sessionSecret) missing.push('SESSION_SECRET');
  if (missing.length > 0) {
    return {
      id: 'secrets_env',
      label: 'Encryption and session secrets',
      status: 'missing',
      detail: `${missing.join(' and ')} ${plural(missing.length, 'is', 'are')} not set. Upstream credentials cannot be decrypted and sessions cannot be signed.`,
      href: null,
    };
  }
  return {
    id: 'secrets_env',
    label: 'Encryption and session secrets',
    status: 'ok',
    detail: 'SECRET_ENCRYPTION_KEY and SESSION_SECRET are set — stored tokens, API keys and SSH keys are encrypted at rest.',
    href: null,
  };
}

function checkAllowedOrigin({ env }) {
  if (!String(env.allowedOrigin || '').trim()) {
    return {
      id: 'allowed_origin',
      label: 'ALLOWED_ORIGIN',
      status: 'warn',
      detail: 'ALLOWED_ORIGIN is not set, so console websocket upgrades fall back to comparing the Origin against the Host header — weaker than an explicit allowlist. Set it to the portal URL.',
      href: null,
    };
  }
  return {
    id: 'allowed_origin',
    label: 'ALLOWED_ORIGIN',
    status: 'ok',
    detail: `Websocket upgrades are checked against ${env.allowedOrigin}.`,
    href: null,
  };
}

function checkPortalBaseUrl({ env, webhookCount }) {
  if (!webhookCount) {
    return {
      id: 'portal_base_url',
      label: 'Notification link base URL',
      status: 'ok',
      detail: 'No notification webhook is configured, so nothing needs a link back to the portal.',
      href: null,
    };
  }
  const base = String(env.portalBaseUrl || '').trim();
  const fallback = String(env.allowedOrigin || '').trim();
  if (base) {
    return {
      id: 'portal_base_url',
      label: 'Notification link base URL',
      status: 'ok',
      detail: `Notification embeds link back to ${base}.`,
      href: null,
    };
  }
  if (fallback) {
    return {
      id: 'portal_base_url',
      label: 'Notification link base URL',
      status: 'ok',
      detail: `PORTAL_BASE_URL is not set; notification links fall back to ALLOWED_ORIGIN (${fallback}).`,
      href: null,
    };
  }
  return {
    id: 'portal_base_url',
    label: 'Notification link base URL',
    status: 'missing',
    detail: `${webhookCount} notification ${plural(webhookCount, 'webhook is', 'webhooks are')} enabled but neither PORTAL_BASE_URL nor ALLOWED_ORIGIN is set — the embeds ship with no link back to the portal.`,
    href: null,
  };
}

// Deliberately self-contained: this reports only whether TRUST_PROXY was set,
// never how many proxy hops the request actually crossed. Observed-hop
// detection lives with the /api/health/client-ip work (issue #80).
function checkTrustProxy({ env }) {
  const value = String(env.trustProxy ?? '').trim();
  if (!value) {
    return {
      id: 'trust_proxy',
      label: 'TRUST_PROXY',
      status: 'warn',
      detail: 'TRUST_PROXY is not set, so Express trusts exactly one proxy hop. If the portal sits behind more than one (nginx plus a cloud load balancer), login rate limiting and the audit log record the proxy address instead of the client.',
      href: null,
    };
  }
  return {
    id: 'trust_proxy',
    label: 'TRUST_PROXY',
    status: 'ok',
    detail: `Set to "${value}" — confirm it matches the number of proxies in front of the portal.`,
    href: null,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Evaluate every portal prerequisite from already-fetched data.
 *
 * @param {object} data
 * @param {Array<{id:number|string, name:string}>} [data.hosts]
 * @param {Array<{hostId:number|string, online:boolean, error?:string}>} [data.hostStatuses]
 * @param {Array<{hostId:number|string, total:number, exposed:number, error?:string}>} [data.hostStorages]
 * @param {Array<{id:number|string, name:string, externalIp:string}>} [data.firewalls]
 * @param {Array<{firewallId:number|string, count:number}>} [data.vlanSyncCounts]
 * @param {number} [data.templateCount]      enabled vm_templates rows
 * @param {number} [data.cloudImageCount]    ready, import-content cloud_images rows
 * @param {number} [data.provisionUserCount] users effectively holding can_provision
 * @param {Array<{id:number|string, name:string, wanIp:string}>} [data.caddyServers]
 * @param {number} [data.siteCount]          published caddy_sites rows
 * @param {number} [data.webhookCount]       enabled notification_webhooks rows
 * @param {object} [data.env]                { secretEncryptionKey, sessionSecret,
 *                                             allowedOrigin, portalBaseUrl, trustProxy }
 * @returns {Array<{id:string,label:string,status:string,detail:string,href:string|null}>}
 */
export function evaluateReadiness(data = {}) {
  const input = {
    hosts: data.hosts || [],
    hostStatuses: data.hostStatuses || [],
    hostStorages: data.hostStorages || [],
    firewalls: data.firewalls || [],
    vlanSyncCounts: data.vlanSyncCounts || [],
    templateCount: data.templateCount || 0,
    cloudImageCount: data.cloudImageCount || 0,
    provisionUserCount: data.provisionUserCount || 0,
    caddyServers: data.caddyServers || [],
    siteCount: data.siteCount || 0,
    webhookCount: data.webhookCount || 0,
    env: data.env || {},
  };

  const checks = [checkPveHosts(input)];

  // Token validity and storage exposure only mean anything once a host exists —
  // otherwise they would repeat the "no host registered" row in two more colors.
  if (input.hosts.length > 0) {
    checks.push(checkPveTokens(input));
    checks.push(checkStorageExposed(input));
  }

  checks.push(checkProvisionSources(input));
  checks.push(checkFirewallExternalIp(input));
  // Same reasoning: a VLAN can only be synced to a firewall that exists.
  if (input.firewalls.length > 0) checks.push(checkFirewallVlanSync(input));
  checks.push(checkCaddyWanIp(input));
  checks.push(checkSecrets(input));
  checks.push(checkAllowedOrigin(input));
  checks.push(checkPortalBaseUrl(input));
  checks.push(checkTrustProxy(input));

  return checks;
}

/** Roll a check list up into { ok, warn, missing, total } for a headline badge. */
export function summarizeReadiness(checks = []) {
  const summary = { ok: 0, warn: 0, missing: 0, total: checks.length };
  for (const c of checks) {
    if (c.status === 'missing') summary.missing += 1;
    else if (c.status === 'warn') summary.warn += 1;
    else summary.ok += 1;
  }
  return summary;
}
