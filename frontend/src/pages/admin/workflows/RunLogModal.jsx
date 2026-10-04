import Modal from '../../../components/Modal.jsx';
import CallList from './CallList.jsx';
import { panel, label, STATUS_LED } from './workflowConstants.js';

export default function RunLogModal({ openRun, onClose }) {
  if (!openRun) return null;

  return (
    <Modal title={`Run log — ${openRun.subject_label || openRun.subject_type}`} onClose={onClose} size="xl">
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={`aaris-led ${STATUS_LED[openRun.status] || 'aaris-led--off'}`} />
          <span className="font-mono uppercase tracking-wider text-gray-300">{openRun.status}</span>
          <span className="text-gray-600">·</span>
          <span className="text-gray-500">{openRun.trigger}</span>
          <span className="text-gray-600">·</span>
          <span className="text-gray-500">{openRun.created_at}</span>
        </div>

        <div className="space-y-2">
          {(openRun.log || []).map((entry, i) => (
            <div key={i} className={`${panel} p-3`}>
              <div className="flex items-center gap-2">
                <span className={`aaris-led ${STATUS_LED[entry.status] || 'aaris-led--off'}`} />
                <span className="font-mono text-[11px] text-gray-300">{entry.label || entry.action}</span>
                <span className="ml-auto font-mono text-[10px] uppercase text-gray-600">{entry.status}</span>
              </div>
              {entry.summary && <p className="mt-1 text-xs text-gray-500">{entry.summary}</p>}
              {entry.error && <p className="mt-1 text-xs text-red-400">{entry.error}</p>}
              {entry.artifacts?.length > 0 && <p className="mt-1 font-mono text-[10px] text-gray-600">created: {entry.artifacts.join(', ')}</p>}
              <CallList calls={entry.calls} />
              {entry.reverted && (
                <div className="mt-1 space-y-0.5">
                  {entry.reverted.map((rv, j) => (
                    <p key={j} className={`font-mono text-[10px] ${rv.ok ? 'text-gray-500' : 'text-red-400'}`}>
                      rollback: {rv.artifact} {rv.ok ? '✓' : `✗ ${rv.error}`}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {openRun.artifacts?.length > 0 && (
          <div>
            <h4 className={`${label} mb-1`}>Recorded artifacts ({openRun.artifacts.length})</h4>
            <pre className="overflow-x-auto border border-gray-800 bg-gray-950 p-2 font-mono text-[10px] text-gray-400">
              {JSON.stringify(openRun.artifacts, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}
