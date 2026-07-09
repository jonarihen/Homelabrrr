import { leaseText, leaseTone } from '../utils/lease.js';

const TONES = {
  ok:      'bg-gray-500/10 text-gray-400 border-gray-500/20',
  warn:    'bg-amber-500/10 text-amber-400 border-amber-500/30',
  expired: 'bg-red-500/10 text-red-400 border-red-500/30',
  muted:   'bg-gray-500/10 text-gray-500 border-gray-500/20',
};

// Countdown badge for a VM lease ("Expires in 12 days"). Renders nothing when
// the VM has no lease.
export default function LeaseBadge({ lease, className = '' }) {
  if (!lease || !lease.hasLease) return null;
  const text = leaseText(lease);
  if (!text) return null;
  const tone = leaseTone(lease) || 'ok';

  return (
    <span
      title={lease.expiresAt ? `Lease expires ${lease.expiresAt} UTC` : 'This VM has no expiry'}
      className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 border ${TONES[tone]} ${className}`}
    >
      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {text}
    </span>
  );
}
