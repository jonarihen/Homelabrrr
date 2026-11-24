import { Router } from 'express';
import { and, eq, ne, sql, count } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  users,
  firewalls,
  firewallVlanSync,
  caddyServers,
  caddySites,
  notificationWebhooks,
  vmTemplates,
  cloudImages,
} from '../../db/schema/index.ts';
import { getHostStatus, getHosts, getHostStoragePools } from '../../proxmox.ts';
import { storageVisibilityMap } from '../../utils/storageVisibility.ts';
import { requireAdmin } from '../../middleware/auth.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { effectivePermissions } from '../../utils/permissions.ts';
import { evaluateReadiness, summarizeReadiness } from '../../utils/readiness.ts';

const router = Router();

// ─── Setup readiness / prerequisites ──────────────────────────────────────────
// Collects the plain data every prerequisite check needs, then hands it to the
// pure evaluator in utils/readiness.js. Each upstream round-trip is wrapped
// individually: one unreachable Proxmox host must degrade its own rows, never
// fail the whole endpoint.

async function collectHostReadiness(hosts) {
  const hostStatuses = await Promise.all(hosts.map(async (h) => {
    try {
      const s = await getHostStatus(h); // already swallows its own errors
      return { hostId: h.id, online: !!s.online, error: s.error || '' };
    } catch (err) {
      return { hostId: h.id, online: false, error: err.message };
    }
  }));

  const hostStorages = await Promise.all(hosts.map(async (h) => {
    // Don't spend another 15s timeout on a host we already know is down.
    const status = hostStatuses.find((s) => s.hostId === h.id);
    if (!status?.online) return { hostId: h.id, total: 0, exposed: 0, error: 'Host unreachable' };
    try {
      const pools = await getHostStoragePools(h);
      const visibility = await storageVisibilityMap(h.id);
      // Missing visibility row ⇒ exposed (default-open), same as the picker.
      const exposed = pools.filter((p) => (visibility.has(p.storage) ? visibility.get(p.storage) : true)).length;
      return { hostId: h.id, total: pools.length, exposed };
    } catch (err) {
      return { hostId: h.id, total: 0, exposed: 0, error: err.message };
    }
  }));

  return { hostStatuses, hostStorages };
}

// Users who can actually reach the New VM page — role grants and the legacy
// per-user column both count, so this goes through effectivePermissions.
async function countProvisioners() {
  const userRows = await db.select().from(users);
  const perms = await Promise.all(userRows.map((u) => effectivePermissions(u)));
  return userRows.filter((u, i) => u.is_admin || perms[i].can_provision).length;
}

router.get('/readiness', requireAdmin, async (req, res) => {
  try {
    const hosts = await getHosts();
    const { hostStatuses, hostStorages } = await collectHostReadiness(hosts);

    // Mirrors websites.js effectiveWanIp(): the manual value wins, otherwise
    // the linked FortiGate's external IP stands in.
    const caddyServerRows = (await db.select({
      id: caddyServers.id, name: caddyServers.name, wan_ip: caddyServers.wan_ip, external_ip: firewalls.external_ip,
    }).from(caddyServers)
      .leftJoin(firewalls, eq(firewalls.id, caddyServers.fortigate_id))
      .orderBy(caddyServers.name)).map((s) => ({
      id: s.id,
      name: s.name,
      wanIp: s.wan_ip || s.external_ip || '',
    }));

    const firewallRows = (await db.select({
      id: firewalls.id, name: firewalls.name, external_ip: firewalls.external_ip,
    }).from(firewalls).orderBy(firewalls.name))
      .map((f) => ({ id: f.id, name: f.name, externalIp: f.external_ip || '' }));
    const vlanSyncCounts = await db.select({
      firewallId: firewallVlanSync.firewall_id, count: count(),
    }).from(firewallVlanSync).groupBy(firewallVlanSync.firewall_id);
    const [{ c: templateCount }] = await db.select({ c: count() }).from(vmTemplates).where(eq(vmTemplates.enabled, true));
    // Same predicate provision.js /images uses: only a ready, import-content
    // volume can be an import-from disk source on PVE 9.
    const [{ c: cloudImageCount }] = await db.select({ c: count() }).from(cloudImages)
      .where(and(eq(cloudImages.status, 'ready'), ne(cloudImages.volid, ''), sql`${cloudImages.volid} NOT LIKE '%:iso/%'`));
    const provisionUserCount = await countProvisioners();
    const [{ c: siteCount }] = await db.select({ c: count() }).from(caddySites);
    const [{ c: webhookCount }] = await db.select({ c: count() }).from(notificationWebhooks).where(eq(notificationWebhooks.enabled, true));

    const checks = evaluateReadiness({
      hosts: hosts.map((h) => ({ id: h.id, name: h.name })),
      hostStatuses,
      hostStorages,
      firewalls: firewallRows,
      vlanSyncCounts,
      templateCount,
      cloudImageCount,
      provisionUserCount,
      caddyServers: caddyServerRows,
      siteCount,
      webhookCount,
      env: {
        secretEncryptionKey: !!process.env.SECRET_ENCRYPTION_KEY,
        sessionSecret: !!process.env.SESSION_SECRET,
        allowedOrigin: process.env.ALLOWED_ORIGIN || '',
        portalBaseUrl: process.env.PORTAL_BASE_URL || '',
        trustProxy: process.env.TRUST_PROXY || '',
      },
    });

    res.json({ checks, summary: summarizeReadiness(checks) });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err.message) });
  }
});

export default router;
