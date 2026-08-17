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

import db from './db.ts';
import { getAllVMs, scheduledStopVM, scheduledStartVM } from './proxmox.ts';
import { logAudit } from './utils/audit.ts';
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
const inFlight = new Set();
let firstRunTimer = null;
let intervalTimer = null;

// logAudit reads req.session/req.ip — synthesize a "system" actor for the loop.
function systemAudit(action, target, detail) {
  try {
    logAudit({ session: { userId: null, username: 'scheduler' }, ip: 'system' }, action, target, detail);
  } catch { /* never let audit failure break the loop */ }
}

function findVmStatus(vms, node, vmid) {
  const candidates = new Set(nodeLookupCandidates(node));
  const target = Number.parseInt(vmid, 10);
  const vm = vms.find((v) => (
    Number.parseInt(v.vmid, 10) === target
    && (candidates.has(v.nodeRef) || candidates.has(v.node))
  ));
  return vm ? vm.status : null;
}

function markAction(id, action, detail) {
  db.prepare('UPDATE vm_schedules SET last_action = ?, last_action_at = ? WHERE id = ?')
    .run(`${action}${detail ? `:${detail}` : ''}`, Date.now(), id);
}

// Execute a stop/start out of band so a slow graceful shutdown doesn't stall the
// tick or other VMs. Updates bookkeeping + audit on completion.
function runAction(schedule, action) {
  if (stopping) return;
  const key = `${schedule.node}/${schedule.vmid}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  const target = `${schedule.node}/${schedule.vmid}`;
  const run = action === 'stop'
    ? scheduledStopVM(schedule.node, schedule.vmid, { timeoutMs: SHUTDOWN_TIMEOUT_MS })
    : scheduledStartVM(schedule.node, schedule.vmid);

  run.then((result) => {
    if (action === 'stop') {
      // Record that the scheduler stopped the VM for this window so a later
      // manual start is recognised as an override rather than a failed stop.
      db.prepare('UPDATE vm_schedules SET stopped_this_window = 1 WHERE id = ?').run(schedule.id);
      markAction(schedule.id, 'stop', result.method);
      systemAudit('vm_schedule_stop', target, `method=${result.method}`);
    } else {
      markAction(schedule.id, 'start', result.method);
      systemAudit('vm_schedule_start', target, `method=${result.method}`);
    }
  }).catch((err) => {
    markAction(schedule.id, `${action}_failed`, '');
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
    if (db.prepare('SELECT COUNT(*) AS c FROM vm_schedules WHERE enabled = 1').get().c === 0) return;

    let vms = [];
    try {
      vms = await getAllVMs();
    } catch (err) {
      console.warn(`[scheduler] could not list VMs this tick: ${err.message}`);
      // Without status we can't act safely — try again next tick.
      return;
    }

    // Read the schedules AFTER the only await so the snapshot is fresh: this
    // makes the per-schedule loop below fully synchronous, so an out-of-band
    // stop/start completion can never interleave and clobber a flag write.
    const schedules = db.prepare('SELECT * FROM vm_schedules WHERE enabled = 1').all();
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

        let manual = s.running_due_to_manual === 1;
        let stoppedThisWindow = s.stopped_this_window === 1;

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

        db.prepare(
          'UPDATE vm_schedules SET last_off = ?, running_due_to_manual = ?, stopped_this_window = ? WHERE id = ?'
        ).run(off ? 1 : 0, manual ? 1 : 0, stoppedThisWindow ? 1 : 0, s.id);
      } catch (err) {
        // One bad schedule must never abort the sweep.
        console.warn(`[scheduler] error evaluating schedule ${s.node}/${s.vmid}: ${err.message}`);
      }
    }
  } catch (err) {
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
