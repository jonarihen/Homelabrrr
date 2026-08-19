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
// actions until skip_until. Every action is audit-logged with its outcome and
// wrapped so one failure never crashes the loop — it's simply retried next tick.

import { and, count, eq } from 'drizzle-orm';
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

async function markAction(id: number, action: string, detail: string) {
  await db.update(vmSchedules)
    .set({ last_action: `${action}${detail ? `:${detail}` : ''}`, last_action_at: Date.now() })
    .where(eq(vmSchedules.id, id));
}

// Execute a stop/start out of band so a slow graceful shutdown doesn't stall the
// tick or other VMs. Updates bookkeeping + audit on completion.
function runAction(schedule: any, action: 'stop' | 'start') {
  if (stopping) return;
  const key = `${schedule.node}/${schedule.vmid}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  const target = `${schedule.node}/${schedule.vmid}`;
  const run = action === 'stop'
    ? scheduledStopVM(schedule.node, schedule.vmid, { timeoutMs: SHUTDOWN_TIMEOUT_MS })
    : scheduledStartVM(schedule.node, schedule.vmid);

  run.then(async (result: any) => {
    if (action === 'stop') {
      // One atomic write: record that the scheduler stopped the VM this window
      // (so a later manual start is recognised as an override rather than a
      // failed stop) together with the action bookkeeping.
      await db.update(vmSchedules)
        .set({ stopped_this_window: true, last_action: `stop:${result.method}`, last_action_at: Date.now() })
        .where(eq(vmSchedules.id, schedule.id));
      systemAudit('vm_schedule_stop', target, `method=${result.method}`);
    } else {
      await markAction(schedule.id, 'start', result.method);
      systemAudit('vm_schedule_start', target, `method=${result.method}`);
    }
  }).catch(async (err: any) => {
    await markAction(schedule.id, `${action}_failed`, '').catch(() => {});
    systemAudit(`vm_schedule_${action}_failed`, target, String(err.message || err).slice(0, 300));
  }).finally(() => {
    inFlight.delete(key);
  });
}

async function tick() {
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

    // Read the schedules AFTER the await so the snapshot is fresh, then commit
    // each row's new flags with an optimistic compare-and-set. The old fully
    // synchronous loop is impossible once writes are async, so instead of
    // trusting the loop's atomicity we guard every flag write with the row's
    // snapshot values — see the CAS below.
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
                  systemAudit('vm_schedule_manual_override', `${s.node}/${s.vmid}`, 'running inside off-window');
                } else if (!inFlight.has(`${s.node}/${s.vmid}`)) {
                  runAction(s, 'stop');
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
            runAction(s, 'start');
          }
        }

        // Optimistic compare-and-set: write the three flag columns only if the
        // row still holds the exact snapshot values we read this tick. If an
        // out-of-band runAction() completion wrote concurrently (setting
        // stopped_this_window, etc.), rowCount is 0 and we skip — the next 60s
        // tick reconverges from the fresh row, and the state machine is
        // idempotent, so nothing is lost. (last_off stays smallint -1/0/1.)
        const res = await db.update(vmSchedules)
          .set({
            last_off: off ? 1 : 0,
            running_due_to_manual: manual,
            stopped_this_window: stoppedThisWindow,
          })
          .where(and(
            eq(vmSchedules.id, s.id),
            eq(vmSchedules.last_off, prevOff),
            eq(vmSchedules.running_due_to_manual, Boolean(s.running_due_to_manual)),
            eq(vmSchedules.stopped_this_window, Boolean(s.stopped_this_window)),
          ));
        if (res.rowCount === 0) continue;
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
    tick();
    intervalTimer = setInterval(tick, TICK_MS);
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
