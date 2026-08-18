import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users, notificationWebhooks } from '../db/schema/index.ts';
import { requireAuth, requireAdmin } from '../middleware/auth.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { logAudit } from '../utils/audit.ts';
import { encryptSecret, decryptSecret } from '../utils/secrets.ts';
import { EVENT_TYPES, sendTestWebhook } from '../utils/notify.ts';

const router = Router();
router.use(requireAuth);

const VALID_EVENT_KEYS = new Set(EVENT_TYPES.map(e => e.key));

// The stored URL is a channel secret — never return it. Show only a masked hint
// so admins can tell webhooks apart.
function maskUrl(encrypted) {
  try {
    const url = decryptSecret(encrypted);
    const m = url.match(/\/webhooks\/(\d+)\//);
    if (m) return `discord.com/api/webhooks/${m[1]}/••••••`;
    return `${url.slice(0, 24)}…`;
  } catch {
    return '••••••';
  }
}

// event_types is a jsonb column: it arrives as an array already, no parsing.
function eventTypesOf(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeEventTypes(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(k => VALID_EVENT_KEYS.has(k)))];
}

function isValidWebhookUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)discord(app)?\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function serializeWebhook(row) {
  return {
    id: row.id,
    name: row.name,
    eventTypes: eventTypesOf(row.event_types),
    enabled: !!row.enabled,
    urlHint: maskUrl(row.url),
    createdAt: row.created_at,
  };
}

async function getWebhook(id) {
  // PostgreSQL rejects a NaN integer parameter, so parse defensively — a
  // non-numeric route id resolves to "not found" (a 404), never a 500.
  const parsed = Number.parseInt(id, 10);
  if (!Number.isInteger(parsed)) return undefined;
  const [row] = await db.select().from(notificationWebhooks)
    .where(eq(notificationWebhooks.id, parsed)).limit(1);
  return row;
}

// ─── Event catalogue (any authenticated user — used by the opt-out UI too) ────

router.get('/event-types', (req, res) => {
  res.json(EVENT_TYPES.map(({ key, label, category, ownerScoped }) => ({ key, label, category, ownerScoped })));
});

// ─── Per-user notification preferences ───────────────────────────────────────

router.get('/preferences', async (req, res) => {
  const [row] = await db.select({ notify_opt_out: users.notify_opt_out }).from(users)
    .where(eq(users.id, req.session.userId)).limit(1);
  res.json({ optOut: !!row?.notify_opt_out });
});

router.put('/preferences', async (req, res) => {
  const optOut = !!req.body.optOut;
  await db.update(users).set({ notify_opt_out: optOut }).where(eq(users.id, req.session.userId));
  res.json({ optOut });
});

// ─── Webhook management (admin only) ─────────────────────────────────────────

router.get('/webhooks', requireAdmin, async (req, res) => {
  const rows = await db.select().from(notificationWebhooks)
    .orderBy(notificationWebhooks.name, notificationWebhooks.id);
  res.json(rows.map(serializeWebhook));
});

router.post('/webhooks', requireAdmin, async (req, res) => {
  const { name, url, eventTypes, enabled } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isValidWebhookUrl(String(url || '').trim())) {
    return res.status(400).json({ error: 'A valid Discord webhook URL (https://discord.com/api/webhooks/…) is required' });
  }

  const [inserted] = await db.insert(notificationWebhooks).values({
    name: String(name).trim(),
    url: encryptSecret(String(url).trim()),
    event_types: sanitizeEventTypes(eventTypes),
    enabled: enabled !== false,
  }).returning({ id: notificationWebhooks.id });

  await logAudit(req, 'notification_webhook_create', String(inserted.id), String(name).trim());
  res.json(serializeWebhook(await getWebhook(inserted.id)));
});

router.put('/webhooks/:id', requireAdmin, async (req, res) => {
  const existing = await getWebhook(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const eventTypes = req.body.eventTypes !== undefined
    ? sanitizeEventTypes(req.body.eventTypes)
    : eventTypesOf(existing.event_types);
  const enabled = req.body.enabled !== undefined ? !!req.body.enabled : existing.enabled;

  // Only replace the URL when a new, real one is supplied — the client sends
  // back the masked hint unchanged when the admin doesn't rotate it.
  let url = existing.url;
  const submittedUrl = req.body.url !== undefined ? String(req.body.url).trim() : '';
  if (submittedUrl && !submittedUrl.includes('•')) {
    if (!isValidWebhookUrl(submittedUrl)) {
      return res.status(400).json({ error: 'A valid Discord webhook URL is required' });
    }
    url = encryptSecret(submittedUrl);
  }

  await db.update(notificationWebhooks)
    .set({ name, url, event_types: eventTypes, enabled })
    .where(eq(notificationWebhooks.id, existing.id));

  await logAudit(req, 'notification_webhook_update', String(existing.id), name);
  res.json(serializeWebhook(await getWebhook(existing.id)));
});

router.delete('/webhooks/:id', requireAdmin, async (req, res) => {
  const existing = await getWebhook(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });
  await db.delete(notificationWebhooks).where(eq(notificationWebhooks.id, existing.id));
  await logAudit(req, 'notification_webhook_delete', String(existing.id), existing.name);
  res.json({ ok: true });
});

router.post('/webhooks/:id/test', requireAdmin, async (req, res) => {
  const existing = await getWebhook(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });
  try {
    await sendTestWebhook(decryptSecret(existing.url));
    await logAudit(req, 'notification_webhook_test', String(existing.id), existing.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: sanitizeError(err.message) });
  }
});

export default router;
