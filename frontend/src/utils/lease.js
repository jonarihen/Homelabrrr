// Formatting helpers for a VM lease view (backend shape from
// backend/src/utils/leases.js → computeLeaseView).

// `daysRemaining` can be absent on a lease the backend could not date, so the
// generic 'Expired' fallback stays reachable.
function expiredText(days) {
  if (days === 0) return 'Expired today';
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  return 'Expired';
}

export function leaseText(lease) {
  if (!lease || !lease.hasLease) return null;
  if (lease.exempt) return 'No expiry (exempt)';
  if (lease.status === 'unlimited') return 'No expiry';

  const d = lease.daysRemaining;
  if (lease.status === 'expired' || d <= 0) return expiredText(d);
  return d === 1 ? 'Expires in 1 day' : `Expires in ${d} days`;
}

// Tone drives badge colour: low-noise gray while healthy, amber near expiry,
// red once expired — matches the AARIS status palette.
export function leaseTone(lease) {
  if (!lease || !lease.hasLease) return null;
  if (lease.exempt || lease.status === 'unlimited') return 'muted';
  if (lease.status === 'expired') return 'expired';
  if (lease.status === 'expiring') return 'warn';
  return 'ok';
}

export function leaseIsExpired(lease) {
  return !!(lease && lease.hasLease && lease.status === 'expired');
}
