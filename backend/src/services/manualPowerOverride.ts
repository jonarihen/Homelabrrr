import { scheduleBoundaryInstants, type WeeklyPowerSchedule } from './powerPolicy.ts';

export type ManualDurationRequest = {
  durationKind?: 'minutes' | 'next_schedule_boundary' | 'until_cleared';
  durationMinutes?: unknown;
  untilCleared?: unknown; // legacy API request
};

// A NULL expiry is reserved for an explicit until-cleared request. Missing
// duration options retain the three-hour default, never an indefinite hold.
export function resolveManualExpiry(request: ManualDurationRequest, schedule: WeeklyPowerSchedule, now: Date): Date | null {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid override time');
  const kind = request.durationKind ?? (request.untilCleared === true ? 'until_cleared' : 'minutes');
  if (!['minutes', 'next_schedule_boundary', 'until_cleared'].includes(kind)
    || (request.untilCleared === true && kind !== 'until_cleared')
    || (request.untilCleared === false && kind === 'until_cleared')
    || (request.untilCleared !== undefined && typeof request.untilCleared !== 'boolean')) {
    throw new Error('Invalid manual override duration');
  }
  if (kind === 'minutes') {
    const minutes = request.durationMinutes == null ? 180 : Number(request.durationMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Invalid manual override duration');
    return new Date(now.getTime() + minutes * 60_000);
  }
  if (request.durationMinutes !== undefined) throw new Error('Invalid manual override duration');
  if (kind === 'until_cleared') return null;
  if (!schedule.enabled) throw new Error('Enable a weekly schedule to use the next-boundary override');
  const next = scheduleBoundaryInstants(schedule, now, new Date(now.getTime() + 8 * 86_400_000))[0];
  if (!next) throw new Error('No next weekly schedule boundary is configured');
  return next;
}
