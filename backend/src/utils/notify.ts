import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users, notificationWebhooks } from '../db/schema/index.ts';
import { decryptSecret } from './secrets.ts';
import { getHosts, getHostStatus } from '../proxmox.ts';

// ─── Event type registry ─────────────────────────────────────────────────────
// The initial set of portal events that can be routed to Discord channels.
// `ownerScoped` events are about one user's own resource — the resource owner
// can opt out of them (users.notify_opt_out) so nothing about their VMs is
// broadcast. Non-scoped events (health/security/notices) always send.
export const EVENT_TYPES = [
  { key: 'deployment.finished', label: 'VM deployment finished', category: 'deployment', ownerScoped: true },
  { key: 'deployment.failed', label: 'VM deployment failed', category: 'deployment', ownerScoped: true },
  { key: 'backup.created', label: 'Backup created', category: 'backup', ownerScoped: true },
  { key: 'backup.failed', label: 'Backup failed', category: 'backup', ownerScoped: true },
  { key: 'node.unreachable', label: 'Node unreachable', category: 'health', ownerScoped: false },
  { key: 'node.recovered', label: 'Node recovered', category: 'health', ownerScoped: false },
  { key: 'notice.published', label: 'New notice published', category: 'notice', ownerScoped: false },
  { key: 'security.lockout', label: 'Account locked out', category: 'security', ownerScoped: false },
  // TIE-IN (#21 — lease expiry): the event type is registered now so admins can
  // pre-select a channel for it, but the emit call site lives in the lease
  // tracker from #21 and is wired in when that branch merges. See PR notes.
  { key: 'lease.expiring', label: 'Lease expiry warning', category: 'lease', ownerScoped: true },
];

const EVENT_BY_KEY = new Map(EVENT_TYPES.map(e => [e.key, e]));

// Discord embed accent colors (decimal RGB) — mirrors the AARIS status palette.
const COLORS = {
  success: 0x3fd97f, // --ok
  failure: 0xe5484d, // red
  warning: 0xffb224, // --warning (amber)
  info: 0x5865f2,    // discord blurple
};

// Loose payload shape — call sites pass ad-hoc event context.
export interface NotifyPayload {
  vm?: unknown;
  domain?: unknown;
  owner?: unknown;
  status?: unknown;
  detail?: unknown;
  url?: string;
  ownerUserId?: number;
  [key: string]: unknown;
}

interface DiscordEmbedField { name: string; value: string; inline?: boolean }
interface DiscordEmbed {
  title: string;
  color: number;
  timestamp: string;
  footer: { text: string };
  description?: string;
  fields?: DiscordEmbedField[];
  url?: string;
}

function colorForEvent(key: string, status: unknown): number {
  if (key === 'deployment.failed' || key === 'backup.failed'
    || key === 'node.unreachable' || key === 'security.lockout') return COLORS.failure;
  if (key === 'node.recovered' || key === 'backup.created') return COLORS.success;
  if (key === 'deployment.finished') return status === 'warning' ? COLORS.warning : COLORS.success;
  if (key === 'lease.expiring') return COLORS.warning;
  return COLORS.info;
}

// Absolute link back to a portal page, if a base URL is configured. Falls back
// to ALLOWED_ORIGIN (the one host we already trust as the portal's public URL).
export function portalLink(path?: string): string | undefined {
  const base = (process.env.PORTAL_BASE_URL || process.env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
  if (!base) return undefined;
  if (!path) return base;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function buildEmbed(eventType: string, payload: NotifyPayload): DiscordEmbed {
  const meta = EVENT_BY_KEY.get(eventType);
  const fields: DiscordEmbedField[] = [];
  const resource = payload.vm || payload.domain;
  if (resource) fields.push({ name: payload.vm ? 'VM' : 'Resource', value: String(resource).slice(0, 256), inline: true });
  if (payload.owner) fields.push({ name: 'Owner', value: String(payload.owner).slice(0, 256), inline: true });
  if (payload.status) fields.push({ name: 'Status', value: String(payload.status).slice(0, 256), inline: true });

  const embed: DiscordEmbed = {
    title: (meta?.label || eventType).slice(0, 256),
    color: colorForEvent(eventType, payload.status),
    timestamp: new Date().toISOString(),
    footer: { text: 'Homelabrrr' },
  };
  if (payload.detail) embed.description = String(payload.detail).slice(0, 2048);
  if (fields.length) embed.fields = fields;
  if (payload.url) embed.url = payload.url; // makes the embed title a link
  return embed;
}

// ─── In-memory queue / rate limiter (per webhook) ────────────────────────────
// Discord allows ~30 requests/min per webhook. Each webhook gets its own queue
// and a sliding-window send log; the drain loop paces sends so a burst of
// events never trips Discord's rate limit. State is in-memory only — dropped
// events on restart are acceptable for notifications.
const RATE_MAX = 28;            // stay safely under Discord's ~30/min
const RATE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_QUEUE = 200;          // drop-and-log if a webhook is wedged

interface WebhookWorker {
  queue: { url: string; body: unknown }[];
  sends: number[];  // epoch-ms timestamps of recent sends (sliding window)
  running: boolean;
}

const workers = new Map<number, WebhookWorker>();

function workerFor(id: number): WebhookWorker {
  let w = workers.get(id);
  if (!w) { w = { queue: [], sends: [], running: false }; workers.set(id, w); }
  return w;
}

async function postJson(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discord webhook returned HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function drain(id: number): Promise<void> {
  const w = workerFor(id);
  if (w.running) return;
  w.running = true;
  try {
    while (w.queue.length) {
      const now = Date.now();
      w.sends = w.sends.filter(t => now - t < RATE_WINDOW_MS);
      if (w.sends.length >= RATE_MAX) {
        const wait = RATE_WINDOW_MS - (now - w.sends[0]) + 50;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const item = w.queue.shift()!;
      w.sends.push(Date.now());
      try {
        await postJson(item.url, item.body);
      } catch (err) {
        console.warn(`[notify] webhook ${id} send failed: ${(err as Error).message}`);
      }
    }
  } finally {
    w.running = false;
  }
}

function enqueue(id: number, url: string, body: unknown): void {
  const w = workerFor(id);
  if (w.queue.length >= MAX_QUEUE) {
    console.warn(`[notify] webhook ${id} queue full — dropping event`);
    return;
  }
  w.queue.push({ url, body });
  drain(id).catch(err => console.warn(`[notify] drain error: ${err.message}`));
}

// ─── Public fire-and-forget entrypoint ───────────────────────────────────────
// notify()'s promise NEVER rejects — every failure (including the DB reads) is
// caught here, so a webhook/config failure must not break provisioning,
// backups, or auth. Call it inline without await right next to the
// corresponding logAudit call; awaiting it is also safe.
export async function notify(eventType: string, payload: NotifyPayload = {}): Promise<void> {
  try {
    const meta = EVENT_BY_KEY.get(eventType);
    if (!meta) return;

    // Per-user opt-out: suppress owner-scoped events when the resource owner
    // has opted out of notifications about their own resources.
    if (meta.ownerScoped && payload.ownerUserId) {
      const [row] = await db.select({ notify_opt_out: users.notify_opt_out })
        .from(users).where(eq(users.id, payload.ownerUserId)).limit(1);
      if (row?.notify_opt_out) return;
    }

    const webhooks = await db.select({
      id: notificationWebhooks.id,
      url: notificationWebhooks.url,
      event_types: notificationWebhooks.event_types,
    }).from(notificationWebhooks).where(eq(notificationWebhooks.enabled, true));
    if (!webhooks.length) return;

    const body = { embeds: [buildEmbed(eventType, payload)] };

    for (const wh of webhooks) {
      // event_types is jsonb — already an array; guard against odd stored shapes.
      const types = Array.isArray(wh.event_types) ? wh.event_types : [];
      if (!types.includes(eventType)) continue;

      let url;
      try { url = decryptSecret(wh.url); } catch { continue; }
      if (!url) continue;

      enqueue(wh.id, url, body);
    }
  } catch (err) {
    // A notifier failure must NEVER surface to the calling flow.
    console.warn(`[notify] failed for ${eventType}: ${(err as Error).message}`);
  }
}

// Send a one-off test embed to a raw webhook URL. Unlike notify(), this awaits
// and rethrows so the admin "Send test" route can report the real outcome.
export async function sendTestWebhook(url: string): Promise<void> {
  await postJson(url, {
    embeds: [{
      title: 'Homelabrrr test notification',
      description: 'If you can read this in Discord, your webhook is wired up correctly.',
      color: COLORS.info,
      timestamp: new Date().toISOString(),
      footer: { text: 'Homelabrrr' },
    }],
  });
}

// ─── Node health monitor ─────────────────────────────────────────────────────
// Polls the same host/node health used by the Overview page and emits
// node.unreachable / node.recovered on state transitions only. The first
// observation of a host/node seeds state silently so a node that is already
// down at startup does not fire a spurious alert.
const nodeHealthState = new Map<string, 'online' | 'offline'>();

export async function pollNodeHealth(): Promise<void> {
  // getHosts() is still synchronous mid-migration; the await is a no-op today
  // and keeps this call site correct once proxmox.ts goes async.
  let hosts;
  try { hosts = await getHosts(); } catch { return; }

  for (const host of hosts) {
    let status;
    try { status = await getHostStatus(host); } catch { status = { online: false }; }

    const hostKey = `host:${host.id}`;
    if (!status.online) {
      if (nodeHealthState.get(hostKey) === 'online') {
        await notify('node.unreachable', {
          domain: host.name,
          status: 'unreachable',
          detail: 'Proxmox host is not responding',
          url: portalLink('/welcome'),
        });
      }
      nodeHealthState.set(hostKey, 'offline');
      continue;
    }

    if (nodeHealthState.get(hostKey) === 'offline') {
      await notify('node.recovered', {
        domain: host.name,
        status: 'online',
        detail: 'Proxmox host is reachable again',
        url: portalLink('/welcome'),
      });
    }
    nodeHealthState.set(hostKey, 'online');

    for (const n of status.nodes || []) {
      const key = `${host.id}~${n.node}`;
      const cur = n.status === 'online' ? 'online' : 'offline';
      const prev = nodeHealthState.get(key);
      if (prev && prev !== cur) {
        await notify(cur === 'online' ? 'node.recovered' : 'node.unreachable', {
          domain: `${host.name} / ${n.node}`,
          status: n.status,
          detail: cur === 'online' ? 'Node is back online' : 'Node is offline',
          url: portalLink('/welcome'),
        });
      }
      nodeHealthState.set(key, cur);
    }
  }
}
