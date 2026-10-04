import CallList from './CallList.jsx';
import { panel, label, inputMono, btnGhost, STATUS_LED } from './workflowConstants.js';

function VlanDryRunFields({ inputs, set }) {
  return (
    <div className="space-y-2">
      <div>
        <label className={`${label} mb-1 block`}>VLAN tag</label>
        <input type="number" value={inputs.tag ?? ''} onChange={(e) => set('tag', e.target.value)} placeholder="1126" className={`${inputMono} w-full`} aria-label="tag" />
      </div>
      <div>
        <label className={`${label} mb-1 block`}>Name</label>
        <input type="text" value={inputs.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="lab-net" className={`${inputMono} w-full`} aria-label="name" />
      </div>
      <div className="flex gap-4">
        <label className="flex items-center gap-1.5 text-xs text-gray-300">
          <input type="checkbox" checked={inputs.allowInternet !== false} onChange={(e) => set('allowInternet', e.target.checked)} className="accent-orange-600" />
          internet
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-300">
          <input type="checkbox" checked={inputs.enableDhcp !== false} onChange={(e) => set('enableDhcp', e.target.checked)} className="accent-orange-600" />
          dhcp
        </label>
      </div>
    </div>
  );
}

function PortForwardDryRunFields({ inputs, set }) {
  return (
    <div className="space-y-2">
      <div>
        <label className={`${label} mb-1 block`}>Name</label>
        <input type="text" value={inputs.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="web-http" className={`${inputMono} w-full`} aria-label="name" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={`${label} mb-1 block`}>Protocol</label>
          <select value={inputs.protocol || 'tcp'} onChange={(e) => set('protocol', e.target.value)} className={`${inputMono} w-full`}>
            <option value="tcp">tcp</option>
            <option value="udp">udp</option>
          </select>
        </div>
        <div>
          <label className={`${label} mb-1 block`}>Ext port</label>
          <input type="number" value={inputs.externalPort ?? ''} onChange={(e) => set('externalPort', e.target.value)} placeholder="8080" className={`${inputMono} w-full`} aria-label="externalPort" />
        </div>
        <div>
          <label className={`${label} mb-1 block`}>Internal IP</label>
          <input type="text" value={inputs.internalIp ?? ''} onChange={(e) => set('internalIp', e.target.value)} placeholder="10.11.26.50" className={`${inputMono} w-full`} aria-label="internalIp" />
        </div>
        <div>
          <label className={`${label} mb-1 block`}>Internal port</label>
          <input type="number" value={inputs.internalPort ?? ''} onChange={(e) => set('internalPort', e.target.value)} placeholder="80" className={`${inputMono} w-full`} aria-label="internalPort" />
        </div>
        <div className="col-span-2">
          <label className={`${label} mb-1 block`}>VLAN interface</label>
          <input type="text" value={inputs.vlanInterface ?? ''} onChange={(e) => set('vlanInterface', e.target.value)} placeholder="vlan1126" className={`${inputMono} w-full`} aria-label="vlanInterface" />
        </div>
      </div>
    </div>
  );
}

function PolicyDryRunFields({ inputs, set }) {
  return (
    <div className="space-y-2">
      <div>
        <label className={`${label} mb-1 block`}>Src interface</label>
        <input type="text" value={inputs.srcInterface ?? ''} onChange={(e) => set('srcInterface', e.target.value)} placeholder="vlan1126" className={`${inputMono} w-full`} aria-label="srcInterface" />
      </div>
      <div>
        <label className={`${label} mb-1 block`}>Dst interface</label>
        <input type="text" value={inputs.dstInterface ?? ''} onChange={(e) => set('dstInterface', e.target.value)} placeholder="vlan1127" className={`${inputMono} w-full`} aria-label="dstInterface" />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-gray-300">
        <input type="checkbox" checked={inputs.bidirectional === true} onChange={(e) => set('bidirectional', e.target.checked)} className="accent-orange-600" />
        bidirectional
      </label>
    </div>
  );
}

function DryRunInputs({ trigger, inputs, setInputs }) {
  const set = (k, v) => setInputs((p) => ({ ...p, [k]: v }));

  if (trigger === 'vlan_provision' || trigger === 'vlan_deprovision') {
    return <VlanDryRunFields inputs={inputs} set={set} />;
  }
  if (trigger === 'port_forward_create' || trigger === 'port_forward_delete') {
    return <PortForwardDryRunFields inputs={inputs} set={set} />;
  }
  if (trigger === 'policy_create' || trigger === 'policy_delete') {
    return <PolicyDryRunFields inputs={inputs} set={set} />;
  }
  return <p className="text-xs text-gray-600">No inputs for this trigger.</p>;
}

export default function WorkflowSidePanel({
  variables,
  onInsertVariable,
  trigger,
  dryInputs,
  setDryInputs,
  onRunDryRun,
  dryRunning,
  dryResult,
  runs,
  onViewRun,
}) {
  return (
    <div className="space-y-4">
      {/* Variable picker */}
      <div className={`${panel} p-4`}>
        <h3 className={`${label} mb-2`}>Variables</h3>
        {variables.length === 0 ? (
          <p className="text-xs text-gray-600">This trigger performs artifact-based teardown — no template variables.</p>
        ) : (
          <>
            <p className="mb-2 text-[11px] text-gray-600">Focus a field, then click to insert (or copy).</p>
            <div className="flex flex-wrap gap-1.5">
              {variables.map((v) => (
                <button
                  key={v}
                  onClick={() => onInsertVariable(v)}
                  className="border border-gray-700 px-1.5 py-0.5 font-mono text-[10px] text-gray-400 hover:border-orange-600 hover:text-orange-300"
                >
                  {v}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Dry-run */}
      <div className={`${panel} p-4`}>
        <h3 className={`${label} mb-2`}>Dry-run preview</h3>
        <DryRunInputs trigger={trigger} inputs={dryInputs} setInputs={setDryInputs} />
        <button className={`${btnGhost} mt-2`} onClick={onRunDryRun} disabled={dryRunning}>
          {dryRunning ? 'Rendering…' : 'Preview calls'}
        </button>
        {dryResult && (
          <div className="mt-3 space-y-2">
            {dryResult.preview.map((item) => (
              <div key={item.position} className="border border-gray-800 bg-gray-950/60 p-2">
                <div className="flex items-center gap-2">
                  <span className={`aaris-led ${item.error ? 'aaris-led--error' : item.skipped ? 'aaris-led--off' : 'aaris-led--ok'}`} />
                  <span className="font-mono text-[11px] text-gray-300">{item.label}</span>
                  {item.skipped && <span className="font-mono text-[10px] uppercase text-gray-600">{item.skipped}</span>}
                </div>
                {item.error && <p className="mt-1 text-[11px] text-red-400">{item.error}</p>}
                <CallList calls={item.calls} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent runs */}
      <div className={`${panel} p-4`}>
        <h3 className={`${label} mb-2`}>Recent runs</h3>
        {runs.length === 0 ? (
          <p className="text-xs text-gray-600">No runs recorded yet.</p>
        ) : (
          <div className="space-y-1">
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => onViewRun(r.id)}
                className="flex w-full items-center gap-2 border border-gray-800 px-2 py-1.5 text-left hover:border-gray-600"
              >
                <span className={`aaris-led ${STATUS_LED[r.status] || 'aaris-led--off'}`} />
                <span className="font-mono text-[11px] text-gray-300">{r.subject_label || r.subject_id || r.subject_type}</span>
                <span className="ml-auto font-mono text-[10px] uppercase text-gray-600">{r.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
