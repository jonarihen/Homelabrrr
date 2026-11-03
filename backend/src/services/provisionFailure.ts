// Last-resort handler for background provisioning work. The inner steps record
// specific failures themselves; this covers anything that escapes them, so a
// row never sits "in progress" forever with the cause only on stderr (#281).
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { provisionedVms } from '../db/schema/index.ts';
import { log } from '../utils/logger.ts';
import { sanitizeError } from '../utils/sanitize.ts';

const IN_PROGRESS = ['cloning', 'creating', 'configuring'];

export async function recordBackgroundProvisionFailure(provisionId: number, vmid: number | string, event: string, err: any): Promise<void> {
  log('error', event, { provisionId, vmid, error: err });
  try {
    // Only an in-progress row: a status an inner handler already set is more specific.
    await db.update(provisionedVms)
      .set({ status: 'needs_review', status_detail: `Background provisioning failed: ${sanitizeError(err?.message || String(err))}` })
      .where(and(eq(provisionedVms.id, provisionId), inArray(provisionedVms.status, IN_PROGRESS)));
  } catch (dbErr) {
    log('error', 'provision_failure_record_failed', { provisionId, error: dbErr });
  }
}
