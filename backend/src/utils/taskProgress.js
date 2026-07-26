// Transfer progress parsed out of a Proxmox task log.
//
// PVE tasks that copy disk data print a progress line every second or so. The
// two shapes that matter for migrations:
//
//   qemu drive mirror (remote_migrate, move_disk):
//     2026-07-26 21:00:03 drive-scsi0: transferred 1.5 GiB of 32.0 GiB (4.69%) in 3s
//     transferred 512.0 MiB of 8.0 GiB (6.25%)
//
//   storage_migrate / qemu-img convert (offline disk moves):
//      42% (13.4 GiB of 32.0 GiB) in 1m 4s
//
// LXC migrations copy with rsync and print no percentage at all — the caller
// falls back to a plain "running" indicator when this returns null.
//
// Percentages are per-disk and restart at 0 for every disk of a multi-disk
// guest, so the disk name travels with the number and the UI shows both.

const SIZE = String.raw`\d+(?:[.,]\d+)?\s*(?:[KMGTPE]i?)?B`;
const DISK = String.raw`drive-[\w.-]+|(?:scsi|virtio|sata|ide|efidisk|tpmstate|mp)\d+|rootfs`;

// "drive-scsi0: transferred 1.5 GiB of 32.0 GiB (4.69%)"
const TRANSFERRED_RE = new RegExp(
  String.raw`(?:^|\s)(?:(${DISK}):\s*)?transferred\s+(${SIZE})\s+of\s+(${SIZE})\s*\((\d+(?:\.\d+)?)%\)`,
  'i',
);

// " 42% (13.4 GiB of 32.0 GiB)"
const PERCENT_FIRST_RE = new RegExp(
  String.raw`(?:^|\s)(?:(${DISK}):\s*)?(\d{1,3}(?:\.\d+)?)%\s*\((${SIZE})\s+of\s+(${SIZE})\)`,
  'i',
);

function normalizeDisk(name) {
  if (!name) return '';
  return name.toLowerCase().startsWith('drive-') ? name.slice('drive-'.length) : name;
}

function clampPercent(value) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

function build(disk, transferred, total, percent) {
  const p = clampPercent(percent);
  if (p === null) return null;
  const label = normalizeDisk(disk);
  const sizes = `${transferred.replace(/\s+/g, ' ')} of ${total.replace(/\s+/g, ' ')}`;
  return { percent: p, disk: label, detail: label ? `${label}: ${sizes}` : sizes };
}

// One log line → { percent, disk, detail } or null when it carries no progress.
export function parseProgressLine(line) {
  if (typeof line !== 'string' || !line) return null;
  const transferred = line.match(TRANSFERRED_RE);
  if (transferred) return build(transferred[1], transferred[2], transferred[3], transferred[4]);
  const percentFirst = line.match(PERCENT_FIRST_RE);
  if (percentFirst) return build(percentFirst[1], percentFirst[3], percentFirst[4], percentFirst[2]);
  return null;
}

// Newest progress in a batch of task-log lines (strings, oldest first), or null
// when none of them carried a percentage.
export function parseTaskProgress(lines) {
  if (!Array.isArray(lines)) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseProgressLine(lines[i]);
    if (parsed) return parsed;
  }
  return null;
}

// Read a task log forward from `start` and report its newest progress. PVE has
// no tail parameter, so the caller keeps the returned `offset` (the last line
// number read) and passes it back next time. Full batches mean there is more to
// read — a poller that fell behind, or a backend that restarted mid-transfer —
// so keep pulling until the log is drained, bounded by `maxBatches`.
//
// `fetchLines({ start, limit })` returns PVE's `[{ n, t }]` rows.
export async function readTaskProgress(fetchLines, { start = 0, batch = 512, maxBatches = 20 } = {}) {
  let offset = Number(start) || 0;
  let progress = null;
  for (let i = 0; i < maxBatches; i++) {
    const lines = await fetchLines({ start: offset, limit: batch });
    if (!Array.isArray(lines) || lines.length === 0) break;
    offset = Number(lines[lines.length - 1].n) || offset + lines.length;
    progress = parseTaskProgress(lines.map((l) => l?.t)) || progress;
    if (lines.length < batch) break;
  }
  return { offset, progress };
}
