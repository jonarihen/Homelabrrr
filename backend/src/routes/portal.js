import { Router } from 'express';
import db from '../db.js';
import { getHosts, getHostStatus } from '../proxmox.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { sanitizeError } from '../utils/sanitize.js';
import { logAudit } from '../utils/audit.js';
import { encodeNodeRef } from '../utils/nodeRef.js';
import { listMaintenance } from '../utils/nodeMaintenance.js';
import { notify, portalLink } from '../utils/notify.js';

const router = Router();
router.use(requireAuth);

const NOTICE_LEVELS = ['info', 'maintenance', 'warning'];

// ─── System status ───────────────────────────────────────────────────────────
// Every authenticated user gets the aggregate (operational/degraded/down);
// per-host details and fleet-wide VM counts are admin-only.

router.get('/status', async (req, res) => {
  try {
    const hosts = getHosts();
    const statuses = await Promise.all(hosts.map(h => getHostStatus(h)));
    const online = statuses.filter(s => s.online).length;
    const overall = hosts.length === 0 ? 'unknown'
      : online === hosts.length ? 'operational'
        : online === 0 ? 'down' : 'degraded';

    // Active node maintenance — visible to every user (the same info is in the
    // auto-published notice). A drained node is amber "maintenance", never a red
    // "down"/"degraded" state, since the host itself is still reachable.
    const maintenance = listMaintenance();

    const payload = {
      overall,
      hostsTotal: hosts.length,
      hostsOnline: online,
      maintenance,
      maintenanceCount: maintenance.length,
    };

    // Cluster-wide CPU/memory usage across all reachable nodes — aggregate
    // only, so it is safe to show every user. CPU is core-weighted: each
    // node's load fraction × its core count.
    const onlineNodes = statuses
      .filter(s => s.online)
      .flatMap(s => s.nodes || [])
      .filter(n => n.status === 'online');
    const totalCores = onlineNodes.reduce((sum, n) => sum + (n.maxcpu || 0), 0);
    const usedCores = onlineNodes.reduce((sum, n) => sum + (n.cpu || 0) * (n.maxcpu || 0), 0);
    const memTotal = onlineNodes.reduce((sum, n) => sum + (n.maxmem || 0), 0);
    const memUsed = onlineNodes.reduce((sum, n) => sum + (n.mem || 0), 0);
    payload.usage = totalCores > 0 ? {
      cpuPct: (usedCores / totalCores) * 100,
      totalCores,
      memUsed,
      memTotal,
      memPct: memTotal > 0 ? (memUsed / memTotal) * 100 : 0,
    } : null;

    if (req.session.isAdmin) {
      payload.hosts = hosts.map((h, i) => {
        const s = statuses[i];
        return {
          id: h.id,
          name: h.name,
          online: s.online,
          version: s.version || null,
          nodes: (s.nodes || []).map(n => {
            const nodeRef = encodeNodeRef(h.id, n.node);
            const m = maintenance.find(x => x.nodeRef === nodeRef || (x.hostId == null && x.node === n.node));
            return {
              node: n.node, nodeRef, status: n.status, cpu: n.cpu, mem: n.mem, maxmem: n.maxmem, uptime: n.uptime,
              maintenance: m ? { id: m.id, reason: m.reason, until: m.until, untilLabel: m.untilLabel } : null,
            };
          }),
          vmCount: s.vmCount ?? null,
          runningVms: s.runningVms ?? null,
        };
      });
      payload.totalVms = statuses.reduce((sum, s) => sum + (s.vmCount || 0), 0);
      payload.runningVms = statuses.reduce((sum, s) => sum + (s.runningVms || 0), 0);
    }

    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

// ─── Notices ─────────────────────────────────────────────────────────────────

router.get('/notices', (req, res) => {
  if (req.query.all === '1' && req.session.isAdmin) {
    return res.json(db.prepare('SELECT * FROM portal_notices ORDER BY created_at DESC, id DESC').all());
  }
  res.json(db.prepare('SELECT * FROM portal_notices WHERE active = 1 ORDER BY created_at DESC, id DESC').all());
});

router.post('/notices', requireAdmin, (req, res) => {
  const { title, body = '', level = 'info' } = req.body;
  if (!String(title || '').trim()) return res.status(400).json({ error: 'Title is required' });
  if (!NOTICE_LEVELS.includes(level)) return res.status(400).json({ error: 'Invalid level' });

  const info = db.prepare(
    'INSERT INTO portal_notices (title, body, level, created_by) VALUES (?, ?, ?, ?)'
  ).run(String(title).trim(), String(body || '').trim(), level, req.session.username || '');

  logAudit(req, 'notice_create', String(info.lastInsertRowid), String(title).trim());
  notify('notice.published', {
    domain: String(title).trim(),
    status: level,
    detail: String(body || '').trim() || undefined,
    url: portalLink('/welcome'),
  });
  res.json(db.prepare('SELECT * FROM portal_notices WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/notices/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM portal_notices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Notice not found' });
  if (existing.source === 'node_maintenance') {
    return res.status(400).json({ error: 'This notice is managed by node maintenance — end maintenance on the PVE Hosts page to close it' });
  }

  const title = req.body.title !== undefined ? String(req.body.title).trim() : existing.title;
  const body = req.body.body !== undefined ? String(req.body.body).trim() : existing.body;
  const level = req.body.level !== undefined ? req.body.level : existing.level;
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!NOTICE_LEVELS.includes(level)) return res.status(400).json({ error: 'Invalid level' });

  db.prepare('UPDATE portal_notices SET title = ?, body = ?, level = ?, active = ? WHERE id = ?')
    .run(title, body, level, active, existing.id);

  logAudit(req, 'notice_update', String(existing.id), `${title}${active !== existing.active ? ` active=${active}` : ''}`);
  res.json(db.prepare('SELECT * FROM portal_notices WHERE id = ?').get(existing.id));
});

router.delete('/notices/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM portal_notices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Notice not found' });
  if (existing.source === 'node_maintenance') {
    return res.status(400).json({ error: 'This notice is managed by node maintenance — end maintenance on the PVE Hosts page to close it' });
  }
  db.prepare('DELETE FROM portal_notices WHERE id = ?').run(existing.id);
  logAudit(req, 'notice_delete', String(existing.id), existing.title);
  res.json({ ok: true });
});

// ─── Useful links ────────────────────────────────────────────────────────────

router.get('/links', (req, res) => {
  res.json(db.prepare('SELECT * FROM portal_links ORDER BY sort_order, id').all());
});

router.post('/links', requireAdmin, (req, res) => {
  const { label, url, description = '' } = req.body;
  if (!String(label || '').trim()) return res.status(400).json({ error: 'Label is required' });
  const trimmedUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) return res.status(400).json({ error: 'URL must start with http:// or https://' });

  const info = db.prepare(
    'INSERT INTO portal_links (label, url, description) VALUES (?, ?, ?)'
  ).run(String(label).trim(), trimmedUrl, String(description || '').trim());

  logAudit(req, 'portal_link_create', String(info.lastInsertRowid), trimmedUrl);
  res.json(db.prepare('SELECT * FROM portal_links WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/links/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM portal_links WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Link not found' });
  db.prepare('DELETE FROM portal_links WHERE id = ?').run(existing.id);
  logAudit(req, 'portal_link_delete', String(existing.id), existing.url);
  res.json({ ok: true });
});

export default router;
