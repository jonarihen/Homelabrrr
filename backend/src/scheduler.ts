// Per-VM power schedule enforcement loop.
//
// Every minute this scans enabled vm_schedules rows, evaluates each VM's OFF
// window in its configured timezone/days, and drives Proxmox power actions:
//   - Entering (or still inside) the OFF window with the VM running → graceful
//     shutdown, hard-stop fallback (proxmox.scheduledStopVM).
//   - Leaving the OFF window with the VM stopped → start.
// Manual overrides win: a manual start inside the OFF window is detected (the
// scheduler already stopped the VM this window, yet it's running again) and
// respected until the next scheduled stop. A "skip tonight" one-off suppresses
// actions until skip_until.

import { and, count, eq, sql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { vmSchedules } from './db/schema/index.ts';
import { getAllVMs, scheduledStopVM, scheduledStartVM } from './proxmox.ts';
import { logAuditEntry } from './utils/audit.ts';
import { nodeLookupCandidates } from './utils/nodeRef.ts';
import {
  isValidTime, isValidTimezone, timeToMinutes, zonedParts, offWindowContains,
} from './utils/schedule.ts';

const TICK_MS = 60_000;
const FIRST_RUN_DELAY_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.VM_SCHEDULE_SHUTDOWN_TIMEOUT_MS) || 120_000;

// Guards against a slow tick overlapping the next timer fire, and against
// issuing a duplicate action for a VM whose stop/start is still in flight.
let ticking = false;
let stopping = false;
const inFlight = new Set<string>();
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

// Synthesize a "system"/"scheduler" actor for the loop's audit entries. Fire and
// forget — an audit failure must never break the loop (conventions rule M13).
function systemAudit(action: string, target: string, detail: string) {
  logAuditEntry({ userId: null, username: 'scheduler', action, target, detail })
    .catch(() => { /* never let audit failure break the loop */ });
}

function findVmStatus(vms: any[], node: any, vmid: any) {
  const candidates = new Set(nodeLookupCandidates(node));
  const target = Number.parseInt(vmid, 10);
  const vm = vms.find((v) => (
    Number.parseInt(v.vmid, 10) === target
    && (candidates.has(v.nodeRef) || candidates.has(v.node))
  ));
  return vm ? vm.status : null;
}

type Schedule = typeof vmSchedules.$inferSelect;

function scheduleConfigurationMatches(schedule: Schedule) {
  return and(
    eq(vmSchedules.id, schedule.id),
    eq(vmSchedules.node, schedule.node),
    eq(vmSchedules.vmid, schedule.vmid),
    eq(vmSchedules.enabled, true),
    sql`${vmSchedules.stop_time} IS NOT DISTINCT FROM ${schedule.stop_time}`,
    sql`${vmSchedules.start_time} IS NOT DISTINCT FROM ${schedule.start_time}`,
    sql`${vmSchedules.days} IS NOT DISTINCT FROM ${schedule.days}`,
    sql`${vmSchedules.timezone} IS NOT DISTINCT FROM ${schedule.timezone}`,
    sql`${vmSchedules.skip_until} IS NOT DISTINCT FROM ${schedule.skip_until}`,
    sql`date_trunc('milliseconds', ${vmSchedules.updated_at}) IS NOT DISTINCT FROM ${schedule.updated_at}`,
  );
}

function scheduleSnapshotMatches(schedule: Schedule) {
  return and(
    scheduleConfigurationMatches(schedule),
    sql`${vmSchedules.last_off} IS NOT DISTINCT FROM ${schedule.last_off}`,
    sql`${vmSchedules.running_due_to_manual} IS NOT DISTINCT FROM ${schedule.running_due_to_manual}`,
    sql`${vmSchedules.stopped_this_window} IS NOT DISTINCT FROM ${schedule.stopped_this_window}`,
  );
}

async function markAction(schedule: Schedule, action: string, detail: string) {
  await db.update(vmSchedules)
    .set({ last_action: `${action}${detail ? `:${detail}` : ''}`, last_action_at: Date.now() })
    .where(scheduleConfigurationMatches(schedule));
}

// Execute a stop/start out of band so a slow graceful shutdown doesn't stall the
// tick or other VMs. Updates bookkeeping + audit on completion.
function runClaimedAction(schedule: Schedule, action: 'stop' | 'start') {
  const key = `${schedule.node}/${schedule.vmid}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  const target = `${schedule.node}/${schedule.vmid}`;
  const run = action === 'stop'
    ? scheduledStopVM(schedule.node, schedule.vmid, { timeoutMs: SHUTDOWN_TIMEOUT_MS })
    : scheduledStartVM(schedule.node, schedule.vmid);

  run.then(async (result: any) => {
    if (action === 'stop') {
      await db.update(vmSchedules)
        .set({
          stopped_this_window: sql`CASE WHEN ${vmSchedules.last_off} = 1 THEN true ELSE ${vmSchedules.stopped_this_window} END`,
          last_action: `stop:${result.method}`,
          last_action_at: Date.now(),
        })
        .where(scheduleConfigurationMatches(schedule));
      systemAudit('vm_schedule_stop', target, `method=${result.method}`);
    } else {
      await markAction(schedule, 'start', result.method);
      systemAudit('vm_schedule_start', target, `method=${result.method}`);
    }
  }).catch(async (err: any) => {
    await markAction(schedule, `${action}_failed`, '').catch(() => {});
    systemAudit(`vm_schedule_${action}_failed`, target, String(err.message || err).slice(0, 300));
  }).finally(() => {
    inFlight.delete(key);
  });
}

export async function runScheduleTick() {
  if (ticking || stopping) return;
  ticking = true;
  try {
    // Cheap early-out before touching Proxmox.
    const [{ c }] = await db.select({ c: count() }).from(vmSchedules).where(eq(vmSchedules.enabled, true));
    if (Number(c) === 0) return;

    let vms: any[] = [];
    try {
      vms = await getAllVMs();
    } catch (err: any) {
      console.warn(`[scheduler] could not list VMs this tick: ${err.message}`);
      // Without status we can't act safely — try again next tick.
      return;
    }

    const schedules = await db.select().from(vmSchedules).where(eq(vmSchedules.enabled, true));
    if (schedules.length === 0) return;

    const now = Date.now();
    const nowDate = new Date(now);

    for (const s of schedules) {
      try {
        // Skip malformed schedules rather than throw (keeps the loop alive).
        if (!isValidTime(s.stop_time) || !isValidTime(s.start_time) || !isValidTimezone(s.timezone)) {
          continue;
        }

        const parts = zonedParts(nowDate, s.timezone);
        const off = offWindowContains(parts, {
          stopM: timeToMinutes(s.stop_time),
          startM: timeToMinutes(s.start_time),
          days: Number(s.days),
        });

        const status = findVmStatus(vms, s.node, s.vmid);
        if (status === null) {
          // VM not visible (host down / not found). Freeze last_off so the
          // window edge is preserved and caught up once it reappears.
          continue;
        }

        const isRunning = status === 'running';
        const isStopped = status === 'stopped';
        const skipping = (Number(s.skip_until) || 0) > now;
        const prevOff = Number(s.last_off);
        const enteringOff = off && prevOff !== 1;
        const leavingOff = !off && prevOff === 1;

        let manual = Boolean(s.running_due_to_manual);
        let stoppedThisWindow = Boolean(s.stopped_this_window);
        let action: 'stop' | 'start' | null = null;

        // A fresh window boundary resets the per-window override/stop flags.
        if (enteringOff || leavingOff) {
          manual = false;
          stoppedThisWindow = false;
        }

        if (!skipping) {
          if (off) {
            if (!manual) {
              if (isRunning) {
                if (stoppedThisWindow) {
                  // We already stopped it this window, yet it's running →
                  // a manual start. Respect it until the next scheduled stop.
                  manual = true;
                } else if (!inFlight.has(`${s.node}/${s.vmid}`)) {
                  action = 'stop';
                }
              } else if (isStopped) {
                // Already off during the window — treat the window as satisfied
                // so a subsequent manual start is detected as an override.
                stoppedThisWindow = true;
              }
            }
          } else if (leavingOff && isStopped && !inFlight.has(`${s.node}/${s.vmid}`)) {
            // Start edge: only act at the transition so a manual daytime
            // shutdown outside the window is not fought.
            action = 'start';
          }
        }

        if (stopping) return;
        const flags = {
          last_off: off ? 1 : 0,
          running_due_to_manual: manual,
          stopped_this_window: stoppedThisWindow,
        };
        const res = await db.update(vmSchedules)
          .set(flags)
          .where(scheduleSnapshotMatches(s));
        if (res.rowCount !== 1) continue;

        if (manual && !s.running_due_to_manual) {
          systemAudit('vm_schedule_manual_override', `${s.node}/${s.vmid}`, 'running inside off-window');
        }
        if (action) runClaimedAction({ ...s, ...flags }, action);
      } catch (err: any) {
        // One bad schedule must never abort the sweep.
        console.warn(`[scheduler] error evaluating schedule ${s.node}/${s.vmid}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[scheduler] tick failed: ${err.message}`);
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  stopping = false;
  firstRunTimer = setTimeout(() => {
    runScheduleTick();
    intervalTimer = setInterval(runScheduleTick, TICK_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log('[scheduler] VM power schedule loop armed');
  return stopScheduler;
}

export function stopScheduler() {
  stopping = true;
  if (firstRunTimer) clearTimeout(firstRunTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstRunTimer = null;
  intervalTimer = null;
}

export async function waitForSchedulerIdle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while ((ticking || inFlight.size > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !ticking && inFlight.size === 0;
}
