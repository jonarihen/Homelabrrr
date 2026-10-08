export function manualPowerDurationRequest(mode, durationKind, durationMinutes) {
  if (durationKind === 'minutes') return { mode, durationKind, durationMinutes };
  if (durationKind === 'next_schedule_boundary' || durationKind === 'until_cleared') return { mode, durationKind };
  throw new Error('Invalid manual power duration');
}
