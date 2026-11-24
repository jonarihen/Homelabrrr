import { useState, useEffect, useId } from 'react';
import Modal from '../../components/Modal.jsx';
import api from '../../api.js';

// ── Cloud-init Credentials Modal ─────────────────────────────────────────────

export default function CloudInitCredentialsModal({ vm, node, vmid, ciuser, onClose, onApplied }) {
  const [storedKeys, setStoredKeys] = useState([]);
  const [keyMode, setKeyMode] = useState('none'); // 'none' | 'stored' | 'paste'
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [pastedKey, setPastedKey] = useState('');
  const [password, setPassword] = useState('');
  const [reboot, setReboot] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { what, rebooted, running } once applied
  const pwId = useId();
  const keyPasteId = useId();

  useEffect(() => {
    api.get('/ssh/keys')
      .then(r => {
        const usable = (r.data || []).filter(k => k.public_key);
        setStoredKeys(usable);
      })
      .catch(() => setStoredKeys([]));
  }, []);

  const submit = async () => {
    setError('');
    const trimmedPw = password.trim();
    const wantsKey = keyMode !== 'none';
    if (!trimmedPw && !wantsKey) {
      setError('Set a new password and/or an SSH public key.');
      return;
    }
    if (trimmedPw && trimmedPw.length < 8) {
      setError('Password must be at least 12 characters.');
      return;
    }
    const body = { reboot };
    if (trimmedPw) body.password = trimmedPw;
    if (keyMode === 'stored') {
      if (!selectedKeyId) { setError('Choose a stored SSH key.'); return; }
      body.sshKeyId = selectedKeyId;
    } else if (keyMode === 'paste') {
      if (!pastedKey.trim()) { setError('Paste an SSH public key.'); return; }
      body.sshKey = pastedKey.trim();
    }

    setSubmitting(true);
    try {
      const r = await api.post(`/vms/${node}/${vmid}/cloudinit-credentials`, body);
      const bits = [];
      if (r.data?.changedPassword) bits.push('password');
      if (r.data?.changedSshKey) bits.push('SSH key');
      const what = bits.join(' and ') || 'credentials';
      // Show the outcome inline (incl. the important reboot notice) rather than
      // closing immediately — reboot only applies the change on next boot.
      setResult({ what, rebooted: !!r.data?.rebooted, running: vm?.status === 'running' });
      onApplied?.();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update credentials');
    } finally {
      setSubmitting(false);
    }
  };

  // Applied — show the outcome and (crucially) the reboot notice.
  if (result) {
    return (
      <Modal title="Reset cloud-init credentials" onClose={onClose} size="md">
        <div className="p-5 space-y-4">
          {result.rebooted ? (
            <div className="flex items-start gap-3 bg-green-900/20 border border-green-800/50 rounded-xl p-4">
              <svg className="w-5 h-5 text-green-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <div className="text-xs text-green-300/90 space-y-1">
                <p className="font-medium text-green-300">Credentials updated</p>
                <p>Cloud-init {result.what} updated. The VM is {result.running ? 'rebooting' : 'starting'} to apply the new credentials.</p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 bg-amber-900/20 border border-amber-800/50 rounded-xl p-4">
              <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
              <div className="text-xs text-amber-200/90 space-y-1">
                <p className="font-medium text-amber-300">Reboot required</p>
                <p>Cloud-init {result.what} updated. Reboot the VM to apply the new credentials.</p>
              </div>
            </div>
          )}
          <div className="flex items-center justify-end">
            <button onClick={onClose} className="text-xs px-5 py-2 btn-primary rounded-lg font-medium">Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Reset cloud-init credentials" onClose={submitting ? () => {} : onClose} size="md">
      <div className="p-5 space-y-4">
        <div className="flex items-start gap-3 bg-blue-900/15 border border-blue-800/40 rounded-xl p-4">
          <svg className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
          <div className="text-xs text-blue-200/80 space-y-1.5">
            <p>
              Set a new cloud-init password and/or replace the injected SSH public key for
              <strong> {vm?.name || `VM ${vmid}`}</strong>{ciuser ? <> (login user <span className="font-mono text-blue-300">{ciuser}</span>)</> : null}.
            </p>
            <p>Cloud-init only re-applies credentials on boot, so a <strong>reboot is required</strong> for the change to take effect. The portal never stores your password.</p>
          </div>
        </div>

        {/* New password */}
        <div>
          <label htmlFor={pwId} className="block text-xs text-gray-500 mb-1.5 font-medium">New password <span className="text-gray-400">(optional)</span></label>
          <input
            id={pwId}
            type="password"
            minLength={12}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Leave blank to keep the current password"
            autoComplete="new-password"
            disabled={submitting}
            className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
          />
        </div>

        {/* SSH public key */}
        <div className="space-y-2">
          <span className="block text-xs text-gray-500 font-medium">SSH public key <span className="text-gray-400">(optional)</span></span>
          <div className="flex flex-wrap gap-2 font-mono text-[11px] uppercase tracking-[0.08em]">
            {[
              { key: 'none', label: 'Leave unchanged' },
              { key: 'stored', label: 'Stored key' },
              { key: 'paste', label: 'Paste key' },
            ].map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setKeyMode(opt.key)}
                disabled={submitting}
                className={`px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${
                  keyMode === opt.key
                    ? 'border-orange-600 bg-orange-600/15 text-orange-400'
                    : 'border-gray-700 text-gray-400 hover:text-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {keyMode === 'stored' && (
            storedKeys.length === 0 ? (
              <p className="text-xs text-gray-500 bg-gray-800/50 rounded-lg p-3">
                No stored SSH keys with a public key. Add one on the <span className="text-gray-300">SSH Keys</span> page or paste a key instead.
              </p>
            ) : (
              <select
                value={selectedKeyId}
                onChange={e => setSelectedKeyId(e.target.value)}
                disabled={submitting}
                className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              >
                <option value="">Select a stored key…</option>
                {storedKeys.map(k => (
                  <option key={k.id} value={k.id}>{k.name}</option>
                ))}
              </select>
            )
          )}

          {keyMode === 'paste' && (
            <textarea
              id={keyPasteId}
              value={pastedKey}
              onChange={e => setPastedKey(e.target.value)}
              rows={3}
              placeholder="ssh-ed25519 AAAA... user@host"
              disabled={submitting}
              className="w-full bg-gray-800 border border-gray-700/50 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all"
            />
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={reboot}
            onChange={e => setReboot(e.target.checked)}
            disabled={submitting}
            className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500/20"
          />
          {vm?.status === 'running' ? 'Reboot now to apply' : 'Start the VM now to apply'}
        </label>

        {error && <p role="alert" className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5">{error}</p>}

        <div className="flex items-center justify-end gap-3">
          <button onClick={onClose} disabled={submitting} className="text-xs px-4 py-2 text-gray-400 hover:text-white transition-colors disabled:opacity-40">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="text-xs px-5 py-2 btn-primary disabled:opacity-40 rounded-lg font-medium inline-flex items-center gap-2"
          >
            {submitting && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            )}
            {submitting ? 'Applying...' : 'Reset credentials'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
