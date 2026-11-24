import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.ts';
import { vmSchedules } from '../../db/schema/index.ts';
import { httpError, sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { nodeLookupCandidates } from '../../utils/nodeRef.ts';
import {
  isValidTime, isValidDaysMask, isValidTimezone, timeToMinutes, serializeSchedule, nextTimeOccurrence, ALL_DAYS,
} from '../../utils/schedule.ts';
import { withVmPolicyWrite } from '../../utils/vmMigrationLock.ts';
import { allowOp } from './shared.ts';

const router = Router();

// Editing a schedule requires strict ownership (admins bypass) — mirrors the
// destructive-op gate. Reads are the 'vm.schedule.read' op at the call site.
function canEditSchedule(req, node, vmid) {
  return allowOp(req, node, vmid, 'vm.schedule.write');
}

// ─── VM Power Schedule ───────────────────────────────────────────────────────
// Owners (and admins) define an automatic OFF window — stop_time/start_time on a
// set of days in a timezone — enforced by the background scheduler (scheduler.js).

async function loadScheduleRow(node, vmid, database: DbOrTx = db) {
  const candidates = nodeLookupCandidates(node);
  if (candidates.length === 0) return null;
  const [row] = await database
    .select()
    .from(vmSchedules)
    .where(and(inArray(vmSchedules.node, candidates), eq(vmSchedules.vmid, parseInt(vmid, 10))))
    .limit(1);
  return row || null;
}

// Read the schedule (view access is enough).
router.get('/:node/:vmid/schedule', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await allowOp(req, node, vmid, 'vm.schedule.read'))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const row = await loadScheduleRow(node, vmid);
  res.json({ schedule: serializeSchedule(row) });
});

// Create / update the schedule (strict ownership; admin bypass).
router.put('/:node/:vmid/schedule', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await canEditSchedule(req, node, vmid))) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }

  const {
    enabled = true,
    stopTime,
    startTime,
    days = ALL_DAYS,
    timezone = 'UTC',
  } = req.body || {};

  if (!isValidTime(stopTime) || !isValidTime(startTime)) {
    return res.status(400).json({ error: 'stopTime and startTime must be valid HH:MM (24-hour) values' });
  }
  if (stopTime === startTime) {
    return res.status(400).json({ error: 'stopTime and startTime cannot be identical' });
  }
  const daysMask = parseInt(days, 10);
  if (!isValidDaysMask(daysMask)) {
    return res.status(400).json({ error: 'days must be a bitmask between 1 and 127 (at least one active day)' });
  }
  if (!isValidTimezone(timezone)) {
    return res.status(400).json({ error: 'timezone must be a valid IANA timezone (e.g. Europe/Copenhagen)' });
  }

  const parsedVmid = parseInt(vmid, 10);
  const enabledBool = !!enabled;

  try {
    const row = await withVmPolicyWrite(node, parsedVmid, async (tx, currentNode) => {
      const existing = await loadScheduleRow(currentNode, vmid, tx);
      const set = {
        enabled: enabledBool, stop_time: stopTime, start_time: startTime, days: daysMask, timezone,
        skip_until: 0, running_due_to_manual: false, stopped_this_window: false,
        last_off: -1, updated_at: new Date(),
      };
      if (existing) {
        const [updated] = await tx.update(vmSchedules).set(set).where(eq(vmSchedules.id, existing.id)).returning();
        return updated;
      }
      const [inserted] = await tx.insert(vmSchedules).values({ node: currentNode, vmid: parsedVmid, ...set })
        .onConflictDoUpdate({ target: [vmSchedules.node, vmSchedules.vmid], set }).returning();
      return inserted;
    }, { userId: req.session.userId });
    await logAudit(req, 'vm_schedule_set', `${node}/${vmid}`, `${enabledBool ? 'on' : 'off'} stop=${stopTime} start=${startTime} days=${daysMask} tz=${timezone}`);
    res.json({ schedule: serializeSchedule(row) });
  } catch (err) { sendError(res, err); }
});

// Delete the schedule entirely.
router.delete('/:node/:vmid/schedule', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await canEditSchedule(req, node, vmid))) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }
  const candidates = nodeLookupCandidates(node);
  const parsedVmid = parseInt(vmid, 10);
  try {
    if (candidates.length > 0) {
      await withVmPolicyWrite(node, parsedVmid, (tx, currentNode) =>
        tx.delete(vmSchedules).where(and(eq(vmSchedules.vmid, parsedVmid), inArray(vmSchedules.node, nodeLookupCandidates(currentNode)))), { userId: req.session.userId });
    }
    await logAudit(req, 'vm_schedule_delete', `${node}/${vmid}`, '');
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// "Skip tonight": suppress scheduler actions until the next start_time so the
// upcoming shutdown is skipped once, then normal enforcement resumes.
router.post('/:node/:vmid/schedule/skip', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await canEditSchedule(req, node, vmid))) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }
  try {
    const row = await withVmPolicyWrite(node, parseInt(vmid, 10), async (tx, currentNode) => {
      const existing = await loadScheduleRow(currentNode, vmid, tx);
      if (!existing || !existing.enabled || !isValidTime(existing.start_time) || !isValidTimezone(existing.timezone)) {
        throw httpError(400, 'No active schedule to skip');
      }
      const skipUntil = nextTimeOccurrence(Date.now(), existing.timezone, timeToMinutes(existing.start_time));
      const [updated] = await tx.update(vmSchedules).set({ skip_until: skipUntil }).where(eq(vmSchedules.id, existing.id)).returning();
      return updated;
    }, { userId: req.session.userId });
    await logAudit(req, 'vm_schedule_skip', `${node}/${vmid}`, new Date(row.skip_until || 0).toISOString());
    res.json({ schedule: serializeSchedule(row) });
  } catch (err) { sendError(res, err); }
});

// Cancel a pending "skip tonight".
router.delete('/:node/:vmid/schedule/skip', async (req, res) => {
  const { node, vmid } = req.params;
  if (!(await canEditSchedule(req, node, vmid))) {
    return res.status(403).json({ error: 'You can only edit schedules for VMs assigned to you' });
  }
  try {
    const row = await withVmPolicyWrite(node, parseInt(vmid, 10), async (tx, currentNode) => {
      const existing = await loadScheduleRow(currentNode, vmid, tx);
      if (!existing) throw httpError(404, 'No schedule found');
      const [updated] = await tx.update(vmSchedules).set({ skip_until: 0 }).where(eq(vmSchedules.id, existing.id)).returning();
      return updated;
    }, { userId: req.session.userId });
    await logAudit(req, 'vm_schedule_skip_cancel', `${node}/${vmid}`, '');
    res.json({ schedule: serializeSchedule(row) });
  } catch (err) { sendError(res, err); }
});

export default router;
