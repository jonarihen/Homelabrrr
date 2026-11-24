import Modal from '../../../components/Modal.jsx';
import { SERVICES, SERVICE_COLORS, describeServices } from './services.js';

// Create Policy modal: service mix, direction and a plain-language preview.
export default function CreatePolicyModal({
  srcVlan, dstVlan, selectedServices, setSelectedServices, bidirectional, setBidirectional, creating, error, onCancel, onCreate,
}) {
  const selectedServiceList = Array.from(selectedServices);
  const serviceSummary = describeServices(selectedServiceList);
  const policyPreviewText = srcVlan && dstVlan
    ? `Allow ${serviceSummary.toLowerCase()} from ${srcVlan.name} to ${dstVlan.name}${bidirectional ? `, and mirror the same access back from ${dstVlan.name} to ${srcVlan.name}` : ''}.`
    : '';
  const policyCountPreview = bidirectional ? 2 : 1;

  const toggleService = (svc) => {
    setSelectedServices(prev => {
      const next = new Set(prev);
      if (svc === 'ALL') return new Set(['ALL']);
      next.delete('ALL');
      if (next.has(svc)) next.delete(svc);
      else next.add(svc);
      if (next.size === 0) next.add('ALL');
      return next;
    });
  };

  return (
    <Modal title="Create Policy" onClose={onCancel} size="sm">

        <div className="space-y-5 p-5">
          <div className="flex items-center justify-center gap-3 rounded-2xl border border-slate-800 bg-slate-800/50 py-3">
            <div className="text-center">
              <p className="text-xs text-slate-500">Source</p>
              <p className="text-sm font-medium text-cyan-300">{srcVlan.name}</p>
              <p className="text-[11px] font-mono text-slate-400">{srcVlan.fwSubnet}</p>
            </div>
            <svg className="h-8 w-8 text-slate-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
            <div className="text-center">
              <p className="text-xs text-slate-500">Destination</p>
              <p className="text-sm font-medium text-emerald-300">{dstVlan.name}</p>
              <p className="text-[11px] font-mono text-slate-400">{dstVlan.fwSubnet}</p>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-slate-400">Allowed Services</label>
            <div className="flex flex-wrap gap-2">
              {SERVICES.map(service => {
                const active = selectedServices.has(service.name);
                const color = SERVICE_COLORS[service.name];
                return (
                  <button
                    key={service.name}
                    type="button"
                    onClick={() => toggleService(service.name)}
                    className="rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] transition-all"
                    style={active
                      ? { color: 'var(--bg)', backgroundColor: color, borderColor: color }
                      : { color: 'var(--muted)', backgroundColor: 'var(--line-soft)', borderColor: 'var(--line)' }}
                  >
                    {service.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Policy Preview</p>
            <p className="mt-2 text-sm text-slate-200">{policyPreviewText}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-cyan-200">
                {policyCountPreview} firewall rule{policyCountPreview !== 1 ? 's' : ''}
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-slate-300">
                Direction: {bidirectional ? 'two-way' : 'one-way'}
              </span>
            </div>
          </div>

          <label className="group flex cursor-pointer items-center gap-3">
            <div className={`relative h-5 w-9 rounded-full transition-colors ${bidirectional ? 'bg-cyan-600' : 'bg-slate-700'}`} onClick={() => setBidirectional(!bidirectional)}>
              <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${bidirectional ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </div>
            <div>
              <span className="text-sm text-slate-300 transition-colors group-hover:text-white">Bidirectional</span>
              <p className="text-[11px] text-slate-400">Also allow {dstVlan.name} to reach {srcVlan.name}</p>
            </div>
          </label>

          {error && <p className="rounded-xl border border-red-800/30 bg-red-900/20 p-3 text-xs text-red-400">{error}</p>}

          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 rounded-xl bg-slate-700 py-2.5 text-sm text-white transition-colors hover:bg-slate-600">
              Cancel
            </button>
            <button
              onClick={onCreate}
              disabled={creating || selectedServices.size === 0}
              className="flex-1 rounded-xl bg-cyan-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Rule'}
            </button>
          </div>
        </div>
    </Modal>
  );
}
