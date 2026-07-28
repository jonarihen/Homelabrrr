// Helpers for telling a finished backup apart from one vzdump is still writing.
//
// Proxmox lists the archive it is currently writing in the storage content the
// moment it creates the file, so `getVMBackups` cannot distinguish a complete
// archive from a partial one. What it does give us is a creation time, and the
// UPID of the running task carries the task's own start time — measured by the
// PVE node's clock, which is the same clock that stamps the archive. Anything
// on the task's storage that appeared at or after the task started is the
// archive that task is writing.

// `UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>:` — every numeric
// field is lowercase hex. Returns null for anything that isn't a well-formed
// UPID, so a malformed value degrades to "nothing is in progress" rather than
// throwing in a poll loop.
export function parseUpid(upid) {
  if (typeof upid !== 'string') return null;
  const parts = upid.split(':');
  if (parts.length < 8 || parts[0] !== 'UPID') return null;
  const startTime = Number.parseInt(parts[4], 16);
  if (!Number.isInteger(startTime) || startTime <= 0) return null;
  return {
    node: parts[1],
    startTime,          // unix seconds, from the PVE node's clock
    type: parts[5],
    id: parts[6],
    user: parts[7],
  };
}

// Seconds of slack allowed before the task's start time. PBS stamps a snapshot
// with the moment the backup begins, which can land a beat before the task
// record itself; a couple of minutes is enough to absorb that without reaching
// back far enough to catch a genuinely older backup.
const CTIME_GRACE_SECONDS = 120;

/**
 * True when `backup` (a row from getVMBackups) is the archive `task` is
 * writing. Both the storage and the timing have to line up — a VM can have
 * backups on several storages, and only the one this task targets is at risk.
 *
 * `task` is a backup_tasks row: { storage, upid, started_epoch }.
 */
export function backupBelongsToTask(backup, task) {
  if (!backup || !task) return false;
  if (!task.storage || backup.storage !== task.storage) return false;

  const startTime = Number(task.started_epoch) || parseUpid(task.upid)?.startTime;
  if (!startTime) return false;

  const ctime = Number(backup.ctime);
  if (!Number.isFinite(ctime)) return false;

  return ctime >= startTime - CTIME_GRACE_SECONDS;
}

/**
 * volids of every listed backup still being written by one of `tasks`.
 * Only tasks still marked running count — a finished task's archive is
 * complete, whatever its timestamps say.
 */
export function inProgressVolids(backups, tasks) {
  const running = (tasks || []).filter((t) => t && t.status === 'running');
  if (running.length === 0) return [];
  const volids = new Set();
  for (const backup of backups || []) {
    if (!backup?.volid) continue;
    if (running.some((task) => backupBelongsToTask(backup, task))) volids.add(backup.volid);
  }
  return [...volids];
}
