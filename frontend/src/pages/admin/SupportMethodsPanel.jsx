import { Badge, Section, Skeleton, btnSm } from './PayPalOperationsPanel.jsx';

// One row per way a member can contribute. `ready` is whether the method can be
// switched on at all; `enabled` is null while unknown.
function methodRows({ paypal, kofi, bank }) {
  return [
    { key: 'paypal', name: 'PayPal', detail: 'One-off and monthly checkout on the Support page (live account).',
      enabled: paypal ? paypal.enabled === true : false, ready: paypal?.configured === true, setup: '#paypal' },
    { key: 'kofi', name: 'Ko-fi', detail: 'A link to your Ko-fi page; payments are matched to members by email.',
      enabled: kofi ? kofi.enabled === true : null, ready: kofi?.configured === true, setup: '#kofi' },
    { key: 'bank', name: 'Bank transfer', detail: 'Members report a transfer; it counts once you confirm it.',
      enabled: bank, ready: true, setup: null },
  ];
}

// The owner's switches for what members are offered. Only methods that are on
// appear on the Support page; with none on, the page is hidden from members.
export default function SupportMethodsPanel({ paypal, kofi, bank, loading, busy, onToggle }) {
  const rows = methodRows({ paypal, kofi, bank });
  const on = rows.filter((row) => row.enabled === true).map((row) => row.name);
  const known = !loading && rows.every((row) => row.enabled !== null);
  return <Section title="Payment methods"
    description="Members only see the methods that are on. With every method off, “Support the Lab” disappears from their menu.">
    <ul className="divide-y divide-gray-800 border border-gray-800 rounded-xl">
      {rows.map((row) => <li key={row.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm text-gray-100">{row.name}
            {loading || row.enabled === null ? <Skeleton className="h-5 w-12" />
              : <Badge tone={row.enabled ? 'ok' : 'neutral'}>{row.enabled ? 'On' : row.ready ? 'Off' : 'Not set up'}</Badge>}
          </p>
          <p className="mt-1 text-xs text-gray-500">{row.detail}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {row.setup && <a href={row.setup} className="font-mono text-xs text-gray-400 hover:text-white underline underline-offset-4 decoration-gray-700">{row.ready ? 'Settings' : 'Set up'} ↓</a>}
          <button type="button" disabled={!!busy || loading || row.enabled === null || (!row.enabled && !row.ready)}
            onClick={() => onToggle(row.key, !row.enabled)} className={btnSm}>
            {busy === `method-${row.key}` ? 'Saving…' : row.enabled ? `Turn off ${row.name}` : `Turn on ${row.name}`}
          </button>
        </div>
      </li>)}
    </ul>
    {known && <p role="status" className={`mt-4 text-xs ${on.length ? 'text-gray-400' : 'text-yellow-300'}`}>
      {on.length ? `Members are offered: ${on.join(', ')}.` : 'No method is on. The Support page is hidden from members; anyone with a running subscription can still open it to cancel.'}
    </p>}
  </Section>;
}
