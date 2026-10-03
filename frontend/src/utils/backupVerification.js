export function backupVerificationLabel(run) {
  if (!run) return 'No backup run recorded';
  if (run.full_restore_verified_at) return 'Full restore verified';
  if (run.status === 'toc_checked' || run.status === 'verified') return 'TOC checked only';
  return run.status;
}
