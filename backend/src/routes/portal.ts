import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { portalNotices, portalLinks } from '../db/schema/index.ts';
import { getHosts, getHostStatus } from '../proxmox.ts';
import { requireAuth, requireAdmin } from '../middleware/auth.ts';
import { sanitizeError } from '../utils/sanitize.ts';
import { logAudit } from '../utils/audit.ts';
import { encodeNodeRef } from '../utils/nodeRef.ts';
import { listMaintenance } from '../utils/nodeMaintenance.ts';
import { notify, portalLink } from '../utils/notify.ts';

const router = Router();
router.use(requireAuth);

const NOTICE_LEVELS = ['info', 'maintenance', 'warning'];

// A non-numeric route id becomes null: eq(id, null) matches no rows (a 404),
// where a raw NaN would make PostgreSQL reject the integer parameter with a 500.
function parseId(value): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

// ─── System status ───────────────────────────────────────────────────────────
// Every authenticated user gets the aggregate (operational/degraded/down);
// per-host details and fleet-wide VM counts are admin-only.

router.get('/status', async (req, res) => {
  try {
    const hosts = await getHosts();
    const statuses = await Promise.all(hosts.map(h => getHostStatus(h)));
    const online = statuses.filter(s => s.online).length;
    const overall = hosts.length === 0 ? 'unknown'
      : online === hosts.length ? 'operational'
        : online === 0 ? 'down' : 'degraded';

    // Active node maintenance — visible to every user (the same info is in the
    // auto-published notice). A drained node is amber "maintenance", never a red
    // "down"/"degraded" state, since the host itself is still reachable.
    const maintenance = await listMaintenance();

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

router.get('/notices', async (req, res) => {
  if (req.query.all === '1' && req.session.isAdmin) {
    return res.json(await db.select().from(portalNotices)
      .orderBy(desc(portalNotices.created_at), desc(portalNotices.id)));
  }
  res.json(await db.select().from(portalNotices)
    .where(eq(portalNotices.active, true))
    .orderBy(desc(portalNotices.created_at), desc(portalNotices.id)));
});

router.post('/notices', requireAdmin, async (req, res) => {
  const { title, body = '', level = 'info' } = req.body;
  if (!String(title || '').trim()) return res.status(400).json({ error: 'Title is required' });
  if (!NOTICE_LEVELS.includes(level)) return res.status(400).json({ error: 'Invalid level' });

  const [inserted] = await db.insert(portalNotices).values({
    title: String(title).trim(),
    body: String(body || '').trim(),
    level,
    created_by: req.session.username || '',
  }).returning({ id: portalNotices.id });

  await logAudit(req, 'notice_create', String(inserted.id), String(title).trim());
  await notify('notice.published', {
    domain: String(title).trim(),
    status: level,
    detail: String(body || '').trim() || undefined,
    url: portalLink('/welcome'),
  });
  const [row] = await db.select().from(portalNotices).where(eq(portalNotices.id, inserted.id)).limit(1);
  res.json(row);
});

router.put('/notices/:id', requireAdmin, async (req, res) => {
  const [existing] = await db.select().from(portalNotices)
    .where(eq(portalNotices.id, parseId(req.params.id))).limit(1);
  if (!existing) return res.status(404).json({ error: 'Notice not found' });
  if (existing.source === 'node_maintenance') {
    return res.status(400).json({ error: 'This notice is managed by node maintenance — end maintenance on the PVE Hosts page to close it' });
  }

  const title = req.body.title !== undefined ? String(req.body.title).trim() : existing.title;
  const body = req.body.body !== undefined ? String(req.body.body).trim() : existing.body;
  const level = req.body.level !== undefined ? req.body.level : existing.level;
  const active = req.body.active !== undefined ? !!req.body.active : existing.active;

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!NOTICE_LEVELS.includes(level)) return res.status(400).json({ error: 'Invalid level' });

  await db.update(portalNotices)
    .set({ title, body, level, active })
    .where(eq(portalNotices.id, existing.id));

  await logAudit(req, 'notice_update', String(existing.id), `${title}${active !== existing.active ? ` active=${active}` : ''}`);
  const [row] = await db.select().from(portalNotices).where(eq(portalNotices.id, existing.id)).limit(1);
  res.json(row);
});

router.delete('/notices/:id', requireAdmin, async (req, res) => {
  const [existing] = await db.select().from(portalNotices)
    .where(eq(portalNotices.id, parseId(req.params.id))).limit(1);
  if (!existing) return res.status(404).json({ error: 'Notice not found' });
  if (existing.source === 'node_maintenance') {
    return res.status(400).json({ error: 'This notice is managed by node maintenance — end maintenance on the PVE Hosts page to close it' });
  }
  await db.delete(portalNotices).where(eq(portalNotices.id, existing.id));
  await logAudit(req, 'notice_delete', String(existing.id), existing.title);
  res.json({ ok: true });
});

// ─── Useful links ────────────────────────────────────────────────────────────

router.get('/links', async (req, res) => {
  res.json(await db.select().from(portalLinks).orderBy(portalLinks.sort_order, portalLinks.id));
});

router.post('/links', requireAdmin, async (req, res) => {
  const { label, url, description = '' } = req.body;
  if (!String(label || '').trim()) return res.status(400).json({ error: 'Label is required' });
  const trimmedUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) return res.status(400).json({ error: 'URL must start with http:// or https://' });

  const [inserted] = await db.insert(portalLinks).values({
    label: String(label).trim(),
    url: trimmedUrl,
    description: String(description || '').trim(),
  }).returning({ id: portalLinks.id });

  await logAudit(req, 'portal_link_create', String(inserted.id), trimmedUrl);
  const [row] = await db.select().from(portalLinks).where(eq(portalLinks.id, inserted.id)).limit(1);
  res.json(row);
});

router.delete('/links/:id', requireAdmin, async (req, res) => {
  const [existing] = await db.select().from(portalLinks)
    .where(eq(portalLinks.id, parseId(req.params.id))).limit(1);
  if (!existing) return res.status(404).json({ error: 'Link not found' });
  await db.delete(portalLinks).where(eq(portalLinks.id, existing.id));
  await logAudit(req, 'portal_link_delete', String(existing.id), existing.url);
  res.json({ ok: true });
});

export default router;
