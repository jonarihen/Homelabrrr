import { Router } from 'express';
import db from '../db.ts';
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

function parseEventTypes(raw) {
  try { const t = JSON.parse(raw || '[]'); return Array.isArray(t) ? t : []; }
  catch { return []; }
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
    eventTypes: parseEventTypes(row.event_types),
    enabled: row.enabled === 1,
    urlHint: maskUrl(row.url),
    createdAt: row.created_at,
  };
}

// ─── Event catalogue (any authenticated user — used by the opt-out UI too) ────

router.get('/event-types', (req, res) => {
  res.json(EVENT_TYPES.map(({ key, label, category, ownerScoped }) => ({ key, label, category, ownerScoped })));
});

// ─── Per-user notification preferences ───────────────────────────────────────

router.get('/preferences', (req, res) => {
  const row = db.prepare('SELECT notify_opt_out FROM users WHERE id = ?').get(req.session.userId);
  res.json({ optOut: row?.notify_opt_out === 1 });
});

router.put('/preferences', (req, res) => {
  const optOut = req.body.optOut ? 1 : 0;
  db.prepare('UPDATE users SET notify_opt_out = ? WHERE id = ?').run(optOut, req.session.userId);
  res.json({ optOut: optOut === 1 });
});

// ─── Webhook management (admin only) ─────────────────────────────────────────

router.get('/webhooks', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM notification_webhooks ORDER BY name, id').all();
  res.json(rows.map(serializeWebhook));
});

router.post('/webhooks', requireAdmin, (req, res) => {
  const { name, url, eventTypes, enabled } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isValidWebhookUrl(String(url || '').trim())) {
    return res.status(400).json({ error: 'A valid Discord webhook URL (https://discord.com/api/webhooks/…) is required' });
  }

  const info = db.prepare(
    'INSERT INTO notification_webhooks (name, url, event_types, enabled) VALUES (?, ?, ?, ?)'
  ).run(
    String(name).trim(),
    encryptSecret(String(url).trim()),
    JSON.stringify(sanitizeEventTypes(eventTypes)),
    enabled === false ? 0 : 1,
  );

  logAudit(req, 'notification_webhook_create', String(info.lastInsertRowid), String(name).trim());
  res.json(serializeWebhook(db.prepare('SELECT * FROM notification_webhooks WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/webhooks/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM notification_webhooks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const eventTypes = req.body.eventTypes !== undefined
    ? sanitizeEventTypes(req.body.eventTypes)
    : parseEventTypes(existing.event_types);
  const enabled = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;

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

  db.prepare('UPDATE notification_webhooks SET name = ?, url = ?, event_types = ?, enabled = ? WHERE id = ?')
    .run(name, url, JSON.stringify(eventTypes), enabled, existing.id);

  logAudit(req, 'notification_webhook_update', String(existing.id), name);
  res.json(serializeWebhook(db.prepare('SELECT * FROM notification_webhooks WHERE id = ?').get(existing.id)));
});

router.delete('/webhooks/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM notification_webhooks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });
  db.prepare('DELETE FROM notification_webhooks WHERE id = ?').run(existing.id);
  logAudit(req, 'notification_webhook_delete', String(existing.id), existing.name);
  res.json({ ok: true });
});

router.post('/webhooks/:id/test', requireAdmin, async (req, res) => {
  const existing = db.prepare('SELECT * FROM notification_webhooks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });
  try {
    await sendTestWebhook(decryptSecret(existing.url));
    logAudit(req, 'notification_webhook_test', String(existing.id), existing.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: sanitizeError(err.message) });
  }
});

export default router;
