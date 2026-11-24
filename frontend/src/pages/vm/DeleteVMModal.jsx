import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../../components/Modal.jsx';
import api from '../../api.js';
import { useToast } from '../../contexts/FeedbackContext.jsx';

// ── Delete VM Modal ─────────────────────────────────────────────────────────

export default function DeleteVMModal({ vm, node, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const expected = vm.name || `VM ${vm.vmid}`;
  const confirmed = confirmText.trim() === expected;

  const doDelete = async () => {
    setDeleting(true); setError('');
    try {
      const r = await api.delete(`/vms/${node}/${vm.vmid}`);
      const failed = r.data?.failedBackups?.length || 0;
      if (failed > 0) {
        toast.error(`VM deleted, but ${failed} backup(s) could not be removed. Check the Proxmox storage manually.`);
      }
      navigate('/dashboard');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete VM');
      setDeleting(false);
    }
  };

  return (
    <Modal title="Delete VM" onClose={deleting ? () => {} : onClose} size="sm">
      <div className="p-5 space-y-4">
        <div className="flex items-start gap-3 bg-red-900/20 border border-red-800/50 rounded-xl p-4">
          <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
          <div className="text-xs text-red-200/80 space-y-1.5">
            <p className="text-sm font-semibold text-red-300">This cannot be undone</p>
            <p>
              <strong>{expected}</strong> (VMID {vm.vmid}) will be permanently destroyed, including its disks
              and <strong>all of its backups</strong>. If the VM is running it will be force-stopped first.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1.5 font-medium">
            Type <span className="text-white font-mono">{expected}</span> to confirm
          </label>
          <input
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            placeholder={expected}
            disabled={deleting}
            autoFocus
            className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/20 transition-all"
          />
        </div>

        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5">{error}</p>}
        {deleting && (
          <p className="text-xs text-yellow-300/80 bg-yellow-900/20 rounded-lg p-2.5">
            Deleting VM and backups — this can take a few minutes. Keep this page open.
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <button onClick={onClose} disabled={deleting} className="text-xs px-4 py-2 text-gray-400 hover:text-white transition-colors disabled:opacity-40">
            Cancel
          </button>
          <button
            onClick={doDelete}
            disabled={!confirmed || deleting}
            className="text-xs px-5 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded-lg font-medium transition-colors inline-flex items-center gap-2"
          >
            {deleting && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            )}
            {deleting ? 'Deleting...' : 'Delete VM'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
