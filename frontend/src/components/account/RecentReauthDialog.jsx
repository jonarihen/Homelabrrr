import { useState } from 'react';
import Modal from '../Modal.jsx';

export default function RecentReauthDialog({ open, onConfirm, onCancel, busy = false, error = '' }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  if (!open) return null;
  const submit = async (event) => {
    event.preventDefault();
    const ok = await onConfirm({ password, code });
    if (ok) { setPassword(''); setCode(''); }
  };
  const cancel = () => { setPassword(''); setCode(''); onCancel(); };
  return (
    <Modal title="Confirm your identity" onClose={cancel} size="sm">
      <form onSubmit={submit} className="p-5 space-y-4">
        <p className="text-xs text-gray-500">Sensitive changes require a recent password and, when enabled, authenticator-code check.</p>
        <input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Current password" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white" autoFocus />
        <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Authenticator code (if enabled)" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white" />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={cancel} className="px-3 py-2 text-xs text-gray-400">Cancel</button><button disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 disabled:opacity-40 text-xs text-white">{busy ? 'Confirming…' : 'Confirm & continue'}</button></div>
      </form>
    </Modal>
  );
}
