// Translate raw upstream failure text into something a portal user can act on.
//
// Proxmox and FortiGate answer failures with their own operator-facing strings
// (`Proxmox POST /nodes/x/qemu/105/status/start → 500: {"data":null,"errors":
// {"":"volume 'local-lvm:vm-105-disk-0' does not exist"}}`). Forwarded verbatim
// they are noise; run through sanitizeError() they become noise with the useful
// parts blanked out. This module recognises the failures people actually hit and
// rewrites them as `{ title, detail, action, href? }`.
//
// Rules of the road:
//   - Pure. No DB, no network, no Express. A string in, a plain object or null out.
//   - Never throws, and never returns a half-filled shape — a rule that cannot
//     produce all of title/detail/action is skipped as if it had not matched.
//   - Unknown input returns null so callers fall back to the existing sanitized
//     behaviour. Adding a rule can only ever improve a message, never lose one.
//   - The raw string still belongs in console.error. Only the browser-facing
//     payload is translated.
//
// Nothing here echoes the upstream text back. Host/node/storage names come from
// the caller's `context` (portal-configured labels) and are redacted on the way
// in, so the IPv4 scrubbing sanitizeError() provides is never weakened.

import { redactUpstream, sanitizeError } from './sanitize.ts';

export const ADMIN_PVE_HOSTS_HREF = '/admin/hosts';
export const ADMIN_FIREWALLS_HREF = '/admin/firewalls';

// ── helpers ──────────────────────────────────────────────────────────────────

/** A caller-supplied label, redacted and trimmed, or null. */
function label(value) {
  const text = redactUpstream(value ?? '').trim();
  return text || null;
}

/** Which upstream produced this text, when it can be told apart. */
function sourceOf(msg) {
  if (/fortigate|fortios/i.test(msg)) return 'fortigate';
  if (/proxmox|\bpve\b|api2\/json/i.test(msg)) return 'proxmox';
  return null;
}

/** "Proxmox host \"pve-01\"" / "the Proxmox host" — never an IP from the text. */
function pveHost(ctx) {
  const name = label(ctx?.host);
  return name ? `Proxmox host "${name}"` : 'the Proxmox host';
}

function anyHost(ctx, msg) {
  const name = label(ctx?.host);
  if (name) return `Host "${name}"`;
  const src = sourceOf(msg);
  if (src === 'fortigate') return 'The FortiGate';
  if (src === 'proxmox') return 'The Proxmox host';
  return 'The upstream host';
}

function hostConsoleHref(msg, ctx) {
  if (ctx?.href) return ctx.href;
  const src = sourceOf(msg);
  if (src === 'fortigate') return ADMIN_FIREWALLS_HREF;
  if (src === 'proxmox') return ADMIN_PVE_HOSTS_HREF;
  return null;
}

/** " on node \"pve-01\"" when the caller told us, otherwise "". */
function onNode(ctx) {
  const name = label(ctx?.node);
  return name ? ` on node "${name}"` : '';
}

// ── the table ────────────────────────────────────────────────────────────────
//
// Ordered, first match wins. Connection-level failures come first because when
// the portal cannot reach or authenticate to a host nothing further in the
// message is the real cause; the resource-level rows follow, most specific
// first. A message carrying two signals therefore resolves to the row nearer
// the top — deterministic, and covered by the tests.

const RULES = [
  {
    id: 'tls-untrusted',
    match(msg, ctx) {
      if (!/unable to verify the first certificate|self[- ]signed certificate|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(msg)) return null;
      return {
        title: 'TLS verification failed',
        detail: `${anyHost(ctx, msg)} presented a certificate the portal does not trust, so the connection was refused.`,
        action: 'Install a trusted certificate on that host, or turn off "Verify TLS" for it.',
        href: hostConsoleHref(msg, ctx),
      };
    },
  },
  {
    id: 'host-unreachable',
    match(msg, ctx) {
      if (!/\b(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/.test(msg)
        && !/request timeout/i.test(msg)) return null;
      return {
        title: 'Host unreachable',
        detail: `${anyHost(ctx, msg)} did not answer. It may be powered off, or the portal container may have no route to it.`,
        action: 'Check that the host is up and reachable from the portal, then try again.',
        href: hostConsoleHref(msg, ctx),
      };
    },
  },
  {
    id: 'fortigate-unauthorized',
    match(msg) {
      if (sourceOf(msg) !== 'fortigate' || !/\b401\b|unauthorized/i.test(msg)) return null;
      return {
        title: 'FortiGate rejected the API key',
        detail: 'The FortiGate refused the portal\'s API key. It may be wrong, expired, or not permitted from the portal\'s address.',
        action: 'Re-enter the API key under Admin → Firewalls.',
        href: ADMIN_FIREWALLS_HREF,
      };
    },
  },
  {
    id: 'fortigate-cli-code',
    match(msg) {
      if (sourceOf(msg) !== 'fortigate') return null;
      const hit = /(?:error|code)\s*[:=]?\s*(-\d+)/i.exec(msg);
      const code = hit && hit[1];
      if (code === '-5') {
        return {
          title: 'FortiGate rejected the change',
          detail: 'FortiGate returned error -5: an object with that name or value already exists.',
          action: 'Rename the object, or remove the existing one first.',
          href: ADMIN_FIREWALLS_HREF,
        };
      }
      if (code === '-3') {
        return {
          title: 'FortiGate rejected the change',
          detail: 'FortiGate returned error -3: the object could not be found, or it is still referenced by another rule or policy.',
          action: 'Remove anything still pointing at it, then try again.',
          href: ADMIN_FIREWALLS_HREF,
        };
      }
      return null;
    },
  },
  {
    id: 'pve-token-privilege',
    match(msg, ctx) {
      if (!/no such user|you can'?t run this|permission check failed|insufficient privileg/i.test(msg)) return null;
      const needed = /permission check failed\s*\(([^)]*)\)/i.exec(msg);
      // `Permission check failed (/vms/105, VM.PowerMgmt)` — the privilege is
      // the last comma-separated field. It is a PVE constant, never user data.
      const priv = needed
        ? redactUpstream(needed[1]).split(',').map((s) => s.trim()).filter(Boolean).pop()
        : null;
      return {
        title: 'Proxmox API token is missing a privilege',
        detail: priv
          ? `${pveHost(ctx)} refused this operation: the portal's API token does not hold ${priv}.`
          : `${pveHost(ctx)} refused this operation because the portal's API token lacks a privilege it needs (for example VM.PowerMgmt or VM.Config.Disk).`,
        action: 'Grant the token that privilege in Proxmox under Datacenter → Permissions, then try again.',
        href: ADMIN_PVE_HOSTS_HREF,
      };
    },
  },
  {
    id: 'pve-token-rejected',
    match(msg, ctx) {
      if (sourceOf(msg) === 'fortigate') return null;
      const status = /(?:→|->)\s*(401|403)\b/.exec(msg);
      if (!status && !/authentication failure/i.test(msg)) return null;
      return {
        title: 'Proxmox rejected the portal\'s API token',
        detail: status
          ? `${pveHost(ctx)} answered ${status[1]} for the portal's API token.`
          : `${pveHost(ctx)} rejected the portal's API token.`,
        action: 'Check the token ID and secret, and that the token holds the privileges this operation needs.',
        href: ADMIN_PVE_HOSTS_HREF,
      };
    },
  },
  {
    id: 'vm-locked',
    match(msg) {
      const hit = /VM is locked\s*(?:\(([^)]*)\))?/i.exec(msg);
      if (!hit) return null;
      const reason = label(hit[1]);
      return {
        title: 'VM is locked by another Proxmox task',
        detail: reason
          ? `Proxmox is already running a "${reason}" task on this VM and will not accept another operation until it finishes.`
          : 'Proxmox is already running a task on this VM and will not accept another operation until it finishes.',
        action: 'Wait for the running task to finish, then try again.',
      };
    },
  },
  {
    id: 'ct-locked',
    match(msg) {
      const hit = /CT is locked\s*(?:\(([^)]*)\))?/i.exec(msg);
      if (!hit) return null;
      const reason = label(hit[1]);
      return {
        title: 'Container is locked by another Proxmox task',
        detail: reason
          ? `Proxmox is already running a "${reason}" task on this container and will not accept another operation until it finishes.`
          : 'Proxmox is already running a task on this container and will not accept another operation until it finishes.',
        action: 'Wait for the running task to finish, then try again.',
      };
    },
  },
  {
    id: 'volume-missing',
    match(msg, ctx) {
      const hit = /volume\s+['"]?([^'"\s]+)['"]?\s+does not exist/i.exec(msg);
      if (!hit) return null;
      const volid = label(hit[1]);
      const storage = volid && volid.includes(':') ? volid.split(':')[0] : null;
      return {
        title: 'The disk is missing',
        detail: storage
          ? `Proxmox cannot find this guest's disk on storage "${storage}"${onNode(ctx)}. It may have been deleted, or the storage may not be mounted on this node.`
          : `Proxmox cannot find this guest's disk${onNode(ctx)}. It may have been deleted, or its storage may not be mounted on this node.`,
        action: 'Check the storage on the Proxmox node, or restore the guest from a backup.',
      };
    },
  },
  {
    id: 'storage-unavailable',
    match(msg, ctx) {
      const hit = /storage\s+['"]?([^'"]+?)['"]?\s+(?:does not exist|is not enabled|is not online|not enabled)/i.exec(msg);
      if (!hit) return null;
      const storage = label(hit[1]);
      return {
        title: 'Storage is not available',
        detail: storage
          ? `Storage "${storage}" is not available${onNode(ctx) || ' on this node'}.`
          : `That storage is not available${onNode(ctx) || ' on this node'}.`,
        action: 'Pick a different storage, or ask an admin to enable it on that node.',
      };
    },
  },
];

// ── public API ───────────────────────────────────────────────────────────────

/** Reject anything that would leave the caller with a half-filled shape. */
function normalize(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const detail = typeof candidate.detail === 'string' ? candidate.detail.trim() : '';
  const action = typeof candidate.action === 'string' ? candidate.action.trim() : '';
  if (!title || !detail || !action) return null;
  const href = typeof candidate.href === 'string' && candidate.href.trim() ? candidate.href.trim() : null;
  return href ? { title, detail, action, href } : { title, detail, action };
}

/**
 * Recognise a known upstream failure.
 *
 * @param {string|Error|null} message raw upstream text (or the Error carrying it)
 * @param {{host?: string, node?: string, href?: string}} [context]
 *        portal-configured labels used to make the message specific. Optional —
 *        without them the wording just stays generic.
 * @returns {{title: string, detail: string, action: string, href?: string}|null}
 *          null when nothing matched, so the caller keeps its current behaviour.
 */
export function translateUpstreamError(message, context = {}) {
  let raw;
  try {
    raw = typeof message === 'string' ? message : String(message?.message ?? message ?? '');
  } catch {
    return null;
  }
  if (!raw || !raw.trim()) return null;
  const ctx = context && typeof context === 'object' ? context : {};

  for (const rule of RULES) {
    let candidate = null;
    try {
      candidate = rule.match(raw, ctx);
    } catch {
      candidate = null; // a broken rule must never take a request down with it
    }
    const shape = normalize(candidate);
    if (shape) return shape;
  }
  return null;
}

/** One-line rendering, for consumers that only understand a plain string. */
export function flattenUpstreamError(shape) {
  if (!shape) return '';
  return `${shape.title} — ${shape.detail} ${shape.action}`.trim();
}

/**
 * The JSON body for a failure that came from upstream.
 *
 * Always carries `error` (a plain string) so the ~167 frontend call sites that
 * read `err.response.data.error` keep working unchanged, and additionally
 * carries the structured fields when the failure was recognised, which
 * <ErrorCallout> renders as title + detail + fix button.
 *
 * This assumes the text IS upstream — it translates or redacts, never passes
 * through. Deciding whether an error is upstream at all belongs to
 * utils/httpError.js, which is the only caller.
 *
 * @param {Error|string} err
 * @param {{host?: string, node?: string, href?: string}} [context]
 */
export function upstreamErrorPayload(err, context = {}) {
  const message = typeof err === 'string' ? err : err?.message;
  const given = context && typeof context === 'object' ? context : {};
  // Upstream clients tag their rejections with the host's portal label (see
  // tagUpstreamHost in proxmox.js), so routes get a named host for free.
  const ctx = {
    host: given.host ?? err?.upstreamHost,
    node: given.node ?? err?.upstreamNode,
    href: given.href ?? err?.upstreamHref,
  };
  const shape = translateUpstreamError(message, ctx);
  if (!shape) return { error: sanitizeError(message) };
  return { error: flattenUpstreamError(shape), ...shape };
}
