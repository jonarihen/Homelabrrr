export const panel = 'border border-gray-800 bg-gray-900/60';
export const label = 'font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500';
export const input = 'w-full bg-gray-950 border border-gray-700 text-gray-100 text-sm px-2.5 py-1.5 focus:border-orange-600 focus:outline-none';
export const inputMono = `${input} font-mono`;
export const btnPrimary = 'border border-orange-600 bg-orange-600 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-950 transition-colors hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed';
export const btnGhost = 'border border-gray-700 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-100 disabled:opacity-40';

export const STATUS_LED = {
  ok: 'aaris-led--ok', skipped: 'aaris-led--off', condition_skipped: 'aaris-led--off',
  error: 'aaris-led--error', error_ignored: 'aaris-led--warning', rolled_back: 'aaris-led--warning',
  success: 'aaris-led--ok', failed: 'aaris-led--error',
};

export function defaultParams(actionDef) {
  const params = {};
  for (const spec of (actionDef?.params || [])) {
    if (spec.default !== undefined) params[spec.name] = spec.default;
  }
  return params;
}

export function Banner({ kind, children, onClose }) {
  const styles = kind === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-orange-500/30 bg-orange-500/10 text-orange-200';
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`flex items-start justify-between gap-4 border ${styles} px-4 py-2.5 text-sm`}><span className="break-words">{children}</span>{onClose && <button onClick={onClose} aria-label="Dismiss" className="shrink-0 text-lg leading-none opacity-60 hover:opacity-100">&times;</button>}</div>;
}

export function CallList({ calls }) {
  if (!calls?.length) return null;
  return <div className="mt-2 space-y-1">{calls.map((call, index) => <div key={index} className="border border-gray-800 bg-gray-950 px-2.5 py-1.5 font-mono text-[11px]"><div className="flex items-center gap-2"><span className="text-orange-500">{call.method}</span><span className="text-gray-300">/api/v2/{call.path}</span>{call.scope && <span className="text-gray-600">· {call.scope}</span>}</div>{call.summary && <div className="mt-0.5 text-gray-500">{call.summary}</div>}{call.body && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-gray-400">{JSON.stringify(call.body)}</pre>}</div>)}</div>;
}
