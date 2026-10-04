import { eq, getTableColumns } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { provisionedVms, users } from '../db/schema/index.ts';
import { decodeNodeRef } from '../utils/nodeRef.ts';
import { notify, portalLink } from '../utils/notify.ts';

export function deploymentTerminalEvent(status: string | null) {
  if (status === 'error' || status === 'failed') return 'deployment.failed';
  if (status === 'ready' || status === 'warning') return 'deployment.finished';
  return null;
}

export async function notifyDeployment(provisionId: number) {
  try {
    const [row] = await db.select({ ...getTableColumns(provisionedVms), username: users.username })
      .from(provisionedVms).leftJoin(users, eq(users.id, provisionedVms.user_id))
      .where(eq(provisionedVms.id, provisionId)).limit(1);
    if (!row) return;
    const event = deploymentTerminalEvent(row.status);
    if (!event) return;
    const { nodeName } = decodeNodeRef(row.node);
    await notify(event, {
      vm: `${row.name} (#${row.vmid}${nodeName ? ` on ${nodeName}` : ''})`,
      owner: row.username || undefined, ownerUserId: row.user_id, status: row.status,
      detail: row.status_detail || undefined, url: portalLink(`/vm/${row.node}/${row.vmid}`),
    });
  } catch {}
}
