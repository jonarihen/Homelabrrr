import api from '../../../api.js';
import { useConfirm, useToast } from '../../../contexts/FeedbackContext.jsx';

// Address Objects tab: list, delete and the add form.
export default function AddressObjectsTab({ objects, selectedFw }) {
  const confirm = useConfirm();
  const toast = useToast();
  const { addressObjects, objectsLoading, loadObjects, showAddrForm, setShowAddrForm, addrForm, setAddrForm, objectError, setObjectError } = objects;
  return (
    <div>
      <div className="flex items-center justify-between border-b border-gray-800/50 px-5 py-3">
        <span className="text-xs text-gray-500">{addressObjects.length} address objects</span>
        <button
          onClick={() => { setShowAddrForm(true); setAddrForm({ name: '', subnet: '', comment: '' }); setObjectError(''); }}
          className="flex items-center gap-1 text-xs text-cyan-400 transition-colors hover:text-cyan-300"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
          Add
        </button>
      </div>
      {objectsLoading ? (
        <div className="py-12 text-center"><span className="text-sm text-gray-500">Loading...</span></div>
      ) : (
        <div className="max-h-96 divide-y divide-gray-800/30 overflow-y-auto">
          {addressObjects.map(object => (
            <div key={object.name} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-gray-800/20">
              <span className="flex-1 truncate text-xs font-medium text-white">{object.name}</span>
              <span className="shrink-0 text-xs font-mono text-gray-400">{object.subnet || object.fqdn || ''}</span>
              <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500">{object.type}</span>
              <button
                onClick={async () => {
                  if (!await confirm({ message: `Delete address object "${object.name}"?`, confirmLabel: 'Delete', danger: true })) return;
                  try {
                    await api.delete(`/admin/objects/addresses/${encodeURIComponent(object.name)}?firewallId=${selectedFw}`);
                    loadObjects();
                  } catch (err) {
                    toast.error(err.response?.data?.error || 'Failed to delete');
                  }
                }}
                className="shrink-0 rounded p-1 text-gray-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </button>
            </div>
          ))}
          {addressObjects.length === 0 && <div className="py-8 text-center text-sm text-gray-500">No address objects</div>}
        </div>
      )}

      {showAddrForm && (
        <div className="border-t border-gray-700 bg-gray-800/30 px-5 py-4">
          <div className="mb-3 grid grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="Name (e.g. NET-10.10.5.0_24)"
              value={addrForm.name}
              onChange={e => setAddrForm(f => ({ ...f, name: e.target.value }))}
              className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Subnet (e.g. 10.10.5.0 255.255.255.0)"
              value={addrForm.subnet}
              onChange={e => setAddrForm(f => ({ ...f, subnet: e.target.value }))}
              className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Comment (optional)"
              value={addrForm.comment}
              onChange={e => setAddrForm(f => ({ ...f, comment: e.target.value }))}
              className="rounded-lg border border-gray-700/50 bg-gray-800 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
            />
          </div>
          {objectError && <p className="mb-2 text-xs text-red-400">{objectError}</p>}
          <div className="flex gap-2">
            <button onClick={() => setShowAddrForm(false)} className="rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-700 hover:text-white">Cancel</button>
            <button
              onClick={async () => {
                setObjectError('');
                try {
                  await api.post('/admin/objects/addresses', { firewallId: selectedFw, name: addrForm.name, subnet: addrForm.subnet, comment: addrForm.comment });
                  setShowAddrForm(false);
                  loadObjects();
                } catch (err) {
                  setObjectError(err.response?.data?.error || 'Failed to create');
                }
              }}
              className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-500"
            >
              Create
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
