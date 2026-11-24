import { useMemo } from 'react';
import { badgeStyle } from './services.js';

// Policies tab: rules grouped by global label (or source interface).
export default function PolicyRulesTab({ policies, onDelete }) {
  const grouped = useMemo(() => {
    const g = {};
    policies.forEach((policy) => {
      const key = policy.globalLabel || policy.srcintf;
      if (!g[key]) g[key] = { label: key, policies: [] };
      g[key].policies.push(policy);
    });
    return g;
  }, [policies]);

  return (
    Object.keys(grouped).length === 0 ? (
      <div className="py-12 text-center">
        <p className="text-sm text-gray-500">No policies yet. Pick a source VLAN in the mesh to start creating one.</p>
      </div>
    ) : (
      <div className="divide-y divide-gray-800/50">
        {Object.values(grouped).map(group => (
          <div key={group.label}>
            <div className="bg-gray-800/30 px-5 py-2.5">
              <span className="text-xs font-medium text-gray-400">{group.label}</span>
            </div>
            <div className="divide-y divide-gray-800/30">
              {group.policies.map(policy => (
                <div key={policy.policyid} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-gray-800/20">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0 text-xs font-mono text-cyan-300">{policy.srcVlan?.name || policy.srcintf}</span>
                    <svg className="h-4 w-4 shrink-0 text-gray-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                    </svg>
                    <span className={`shrink-0 text-xs font-mono ${policy.isInternet ? 'text-amber-400' : 'text-emerald-300'}`}>
                      {policy.isInternet ? 'Internet' : (policy.dstVlan?.name || policy.dstintf)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {policy.service.map(service => (
                      <span
                        key={`${policy.policyid}-${service}`}
                        className="rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.14em]"
                        style={badgeStyle(service, policy.action)}
                      >
                        {service}
                      </span>
                    ))}
                  </div>

                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${
                    policy.action === 'accept'
                      ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                      : 'bg-red-500/10 text-red-300 ring-red-500/20'
                  }`}>
                    {policy.action}
                  </span>

                  {!policy.isInternet && (
                    <button
                      onClick={() => onDelete(policy.policyid)}
                      className="shrink-0 rounded p-1 text-gray-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  );
}
