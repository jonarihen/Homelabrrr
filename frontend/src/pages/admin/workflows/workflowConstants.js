// AARIS operator-console styling
export const panel = 'border border-gray-800 bg-gray-900/60';
export const label = 'font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500';
export const input = 'w-full bg-gray-950 border border-gray-700 text-gray-100 text-sm px-2.5 py-1.5 focus:border-orange-600 focus:outline-none';
export const inputMono = `${input} font-mono`;
export const btnPrimary = 'border border-orange-600 bg-orange-600 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-gray-950 transition-colors hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed';
export const btnGhost = 'border border-gray-700 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-100 disabled:opacity-40';

export const STATUS_LED = {
  ok: 'aaris-led--ok',
  skipped: 'aaris-led--off',
  condition_skipped: 'aaris-led--off',
  error: 'aaris-led--error',
  error_ignored: 'aaris-led--warning',
  rolled_back: 'aaris-led--warning',
  success: 'aaris-led--ok',
  failed: 'aaris-led--error',
};

export function defaultParams(actionDef) {
  const p = {};
  for (const spec of (actionDef?.params || [])) {
    if (spec.default !== undefined) p[spec.name] = spec.default;
  }
  return p;
}
