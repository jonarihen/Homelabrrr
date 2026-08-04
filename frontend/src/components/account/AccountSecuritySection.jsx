import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import api from '../../api.js';
import RecentReauthDialog from './RecentReauthDialog.jsx';

const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500';

function fmt(value) {
  if (!value) return 'unknown';
  const date = new Date(typeof value === 'number' ? value : String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export default function AccountSecuritySection() {
  const [passkeys, setPasskeys] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [recovery, setRecovery] = useState({ remaining: 0 });
  const [newCodes, setNewCodes] = useState([]);
  const [passkeyName, setPasskeyName] = useState('My passkey');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [reauth, setReauth] = useState(null);
  const [reauthBusy, setReauthBusy] = useState(false);
  const [reauthError, setReauthError] = useState('');

  const load = async () => {
    try {
      const [passkeyResult, recoveryResult, sessionResult] = await Promise.all([
        api.get('/auth/passkeys'), api.get('/auth/recovery-codes'), api.get('/auth/sessions'),
      ]);
      setPasskeys(passkeyResult.data);
      setRecovery(recoveryResult.data);
      setSessions(sessionResult.data);
    } catch (err) { setMessage(`error:${err.response?.data?.error || 'Could not load account security'}`); }
  };
  useEffect(() => { load(); }, []);

  const run = async (key, action) => {
    setBusy(key); setMessage('');
    try { await action(); await load(); }
    catch (err) {
      if (err.response?.data?.code === 'REAUTHENTICATION_REQUIRED') {
        setReauth({ key, action });
        setReauthError('');
        return;
      }
      const text = err.response?.data?.error || err.message || 'Operation failed';
      setMessage(`error:${text}`);
    } finally { setBusy(''); }
  };

  const registerPasskey = () => run('passkey', async () => {
    const { data: optionsJSON } = await api.post('/auth/passkeys/register/options');
    const credential = await startRegistration({ optionsJSON });
    await api.post('/auth/passkeys/register/verify', { name: passkeyName.trim() || 'Passkey', credential });
    setMessage('Passkey registered');
  });

  const generateCodes = () => run('codes', async () => {
    const { data } = await api.post('/auth/recovery-codes');
    setNewCodes(data.codes);
    setRecovery({ remaining: data.codes.length, createdAt: new Date().toISOString() });
    setMessage('Recovery codes replaced. Save them now; they will not be shown again.');
  });

  const copyCodes = async () => {
    await navigator.clipboard.writeText(newCodes.join('\n'));
    setMessage('Recovery codes copied');
  };

  const isError = message.startsWith('error:');
  const confirmReauth = async (credentials) => {
    setReauthBusy(true); setReauthError('');
    try {
      await api.post('/auth/reauthenticate', credentials);
      const pending = reauth;
      setReauth(null);
      await run(pending.key, pending.action);
      return true;
    } catch (err) {
      setReauthError(err.response?.data?.error || 'Identity confirmation failed');
      return false;
    } finally { setReauthBusy(false); }
  };
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-6">
      <RecentReauthDialog open={!!reauth} busy={reauthBusy} error={reauthError} onCancel={() => setReauth(null)} onConfirm={confirmReauth} />
      <div>
        <h2 className="text-sm font-semibold text-white">Passkeys, recovery & sessions</h2>
        <p className="text-xs text-gray-500 mt-1">Use phishing-resistant authentication and revoke devices you no longer recognize.</p>
      </div>
      {message && <p className={`text-xs ${isError ? 'text-red-400' : 'text-green-400'}`}>{isError ? message.slice(6) : message}</p>}

      <section className="space-y-3">
        <h3 className="text-xs uppercase tracking-wide text-gray-500">Passkeys</h3>
        <div className="flex gap-2">
          <input value={passkeyName} maxLength={64} onChange={(event) => setPasskeyName(event.target.value)} className={inputCls} aria-label="Passkey name" />
          <button disabled={!!busy} onClick={registerPasskey} className="px-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm text-white whitespace-nowrap">{busy === 'passkey' ? 'Waiting…' : 'Add passkey'}</button>
        </div>
        {passkeys.length === 0 ? <p className="text-xs text-gray-600">No passkeys registered.</p> : <ul className="space-y-2">{passkeys.map((passkey) => (
          <li key={passkey.id} className="flex justify-between gap-3 bg-gray-800/50 rounded-lg px-3 py-2">
            <div><p className="text-sm text-white">{passkey.name}</p><p className="text-[11px] text-gray-500">Created {fmt(passkey.createdAt)} · Last used {fmt(passkey.lastUsedAt)}</p></div>
            <button disabled={!!busy} onClick={() => run(`passkey-${passkey.id}`, () => api.delete(`/auth/passkeys/${encodeURIComponent(passkey.id)}`))} className="text-xs text-red-400">Remove</button>
          </li>
        ))}</ul>}
      </section>

      <section className="space-y-3 border-t border-gray-800 pt-5">
        <div className="flex items-center justify-between gap-4"><div><h3 className="text-xs uppercase tracking-wide text-gray-500">Recovery codes</h3><p className="text-xs text-gray-500 mt-1">{recovery.remaining || 0} unused code(s)</p></div><button disabled={!!busy} onClick={generateCodes} className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-xs text-white">{busy === 'codes' ? 'Generating…' : 'Generate new codes'}</button></div>
        {newCodes.length > 0 && <div className="border border-yellow-700/40 bg-yellow-950/20 rounded-xl p-4"><div className="grid grid-cols-2 gap-2 font-mono text-xs text-yellow-200">{newCodes.map((code) => <span key={code}>{code}</span>)}</div><button onClick={copyCodes} className="text-xs text-yellow-300 mt-3">Copy all</button></div>}
      </section>

      <section className="space-y-3 border-t border-gray-800 pt-5">
        <div className="flex items-center justify-between"><h3 className="text-xs uppercase tracking-wide text-gray-500">Active sessions</h3><button disabled={!!busy} onClick={() => run('all-sessions', () => api.delete('/auth/sessions'))} className="text-xs text-red-400">Revoke all others</button></div>
        <ul className="space-y-2">{sessions.map((session) => (
          <li key={session.id} className="flex justify-between gap-3 bg-gray-800/50 rounded-lg px-3 py-2">
            <div className="min-w-0"><p className="text-sm text-white">{session.current ? 'Current session' : session.userAgent || 'Unknown browser'}</p><p className="text-[11px] text-gray-500 truncate">{session.ip || 'unknown address'} · last seen {fmt(session.lastSeenAt)}</p></div>
            {!session.current && <button disabled={!!busy} onClick={() => run(`session-${session.id}`, () => api.delete(`/auth/sessions/${encodeURIComponent(session.id)}`))} className="text-xs text-red-400">Revoke</button>}
          </li>
        ))}</ul>
      </section>
    </div>
  );
}
