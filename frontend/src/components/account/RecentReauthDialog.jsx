import { useState } from 'react';

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
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-2xl p-5 space-y-4" role="dialog" aria-modal="true" aria-label="Confirm your identity">
        <div><h2 className="text-white font-semibold">Confirm your identity</h2><p className="text-xs text-gray-500 mt-1">Sensitive changes require a recent password and, when enabled, authenticator-code check.</p></div>
        <input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Current password" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white" autoFocus />
        <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Authenticator code (if enabled)" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white" />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={cancel} className="px-3 py-2 text-xs text-gray-400">Cancel</button><button disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 disabled:opacity-40 text-xs text-white">{busy ? 'Confirming…' : 'Confirm & continue'}</button></div>
      </form>
    </div>
  );
}
