import { Router } from 'express';
import { eq, desc, getTableColumns } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { provisionedVms, users, vmTemplates, cloudImages } from '../../db/schema/index.ts';
import { getTaskStatus } from '../../proxmox.ts';
import { serializeProvisionRow } from './shared.ts';

const router = Router();

// ─── Provisioning status ─────────────────────────────────────────────────────

router.get('/status', async (req: any, res: any) => {
  const rows = await db
    .select({
      ...getTableColumns(provisionedVms),
      username: users.username,
      template_name: vmTemplates.name,
      image_name: cloudImages.name,
    })
    .from(provisionedVms)
    .leftJoin(users, eq(users.id, provisionedVms.user_id))
    .leftJoin(vmTemplates, eq(vmTemplates.id, provisionedVms.template_id))
    .leftJoin(cloudImages, eq(cloudImages.id, provisionedVms.cloud_image_id))
    .where(req.session.isAdmin ? undefined : eq(provisionedVms.user_id, req.session.userId))
    .orderBy(desc(provisionedVms.created_at))
    .limit(50);
  res.json(rows.map(serializeProvisionRow));
});

router.get('/status/:id', async (req: any, res: any) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  const [row] = await db
    .select({
      ...getTableColumns(provisionedVms),
      template_name: vmTemplates.name,
      image_name: cloudImages.name,
    })
    .from(provisionedVms)
    .leftJoin(vmTemplates, eq(vmTemplates.id, provisionedVms.template_id))
    .leftJoin(cloudImages, eq(cloudImages.id, provisionedVms.cloud_image_id))
    .where(eq(provisionedVms.id, id))
    .limit(1);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!req.session.isAdmin && row.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Resilience: surface a failed PVE task even if the in-process poller missed
  // it (e.g. the backend restarted mid-job). Success is finalized by the
  // background pollers, so we never flip to 'ready' here — that would race the
  // still-running configure/import steps.
  if (row.upid && (row.status === 'cloning' || row.status === 'creating' || row.status === 'configuring')) {
    try {
      const task = await getTaskStatus(row.node, row.upid);
      if (task.status === 'stopped' && task.exitstatus !== 'OK') {
        await db.update(provisionedVms)
          .set({ status: 'error', status_detail: task.exitstatus || 'Task failed' })
          .where(eq(provisionedVms.id, row.id));
        row.status = 'error';
        row.status_detail = task.exitstatus || 'Task failed';
      }
    } catch { /* ignore */ }
  }

  res.json(serializeProvisionRow(row));
});

export default router;
