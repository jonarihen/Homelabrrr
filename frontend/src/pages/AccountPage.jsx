import { useState, useEffect } from 'react';
import Layout from '../components/Layout.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import api from '../api.js';
import AccountSecuritySection from '../components/account/AccountSecuritySection.jsx';

const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';

export default function AccountPage() {
  useDocumentTitle('Account');
  const { user, setUser } = useAuth();
  const enrollmentOnly = user?.twoFactorSetupRequired || (user?.require2fa && !user?.twoFactorEnabled);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="aaris-display text-xl text-gray-100">Account Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your profile, password, and security</p>
        </div>

        {/* 2FA enforcement banner */}
        {user?.require2fa && !user?.twoFactorEnabled && (
          <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-2xl p-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <div>
              <p className="text-sm text-yellow-300 font-medium">Two-factor authentication required</p>
              <p className="text-xs text-yellow-400/70 mt-0.5">Your administrator requires all accounts to have 2FA enabled. Please set it up below.</p>
            </div>
          </div>
        )}

        {enrollmentOnly ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <p className="text-sm text-white font-medium">Finish 2FA setup first</p>
            <p className="text-xs text-gray-500 mt-1.5">Username and password changes are locked until this account has a working second factor.</p>
          </div>
        ) : (
          <>
            <UsernameSection user={user} setUser={setUser} />
            <PasswordSection />
          </>
        )}
        <TwoFactorSection user={user} setUser={setUser} />
        {!enrollmentOnly && <AccountSecuritySection />}
        {!enrollmentOnly && <NotificationsSection />}
        {!enrollmentOnly && <ConnectionSection />}
        {!enrollmentOnly && <ApiTokensSection />}
      </div>
    </Layout>
  );
}

// ── Username ─────────────────────────────────────────────────────────────────

function UsernameSection({ user, setUser }) {
  const [username, setUsername] = useState(user?.username || '');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setMsg('');
    try {
      await api.put('/auth/change-username', { username });
      setUser(u => ({ ...u, username }));
      setMsg('Username updated');
    } catch (e) {
      setMsg('error:' + (e.response?.data?.error || 'Failed'));
    } finally { setSaving(false); }
  };

  const isError = msg.startsWith('error:');

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 bg-blue-500/10 rounded-xl flex items-center justify-center">
          <svg className="w-4.5 h-4.5 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Username</h2>
          <p className="text-xs text-gray-500">Change your display name</p>
        </div>
      </div>
      <form onSubmit={submit} className="flex items-end gap-3">
        <div className="flex-1">
          <input type="text" required value={username} onChange={e => { setUsername(e.target.value); setMsg(''); }} className={inputCls} />
        </div>
        <button type="submit" disabled={saving || username === user?.username} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors shrink-0">
          {saving ? 'Saving...' : 'Update'}
        </button>
      </form>
      {msg && <p className={`text-xs mt-2 ${isError ? 'text-red-400' : 'text-green-400'}`}>{isError ? msg.slice(6) : msg}</p>}
    </div>
  );
}

// ── Password ─────────────────────────────────────────────────────────────────

function PasswordSection() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirmPassword) { setMsg('error:Passwords do not match'); return; }
    setSaving(true); setMsg('');
    try {
      await api.put('/auth/change-password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setMsg('Password updated');
    } catch (e) {
      setMsg('error:' + (e.response?.data?.error || 'Failed'));
    } finally { setSaving(false); }
  };

  const isError = msg.startsWith('error:');

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 bg-purple-500/10 rounded-xl flex items-center justify-center">
          <svg className="w-4.5 h-4.5 text-purple-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Password</h2>
          <p className="text-xs text-gray-500">Change your account password</p>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1.5 font-medium">Current Password</label>
          <input type="password" required value={form.currentPassword} onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))} className={inputCls} autoComplete="current-password" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1.5 font-medium">New Password</label>
            <input type="password" required minLength={12} value={form.newPassword} onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))} className={inputCls} autoComplete="new-password" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1.5 font-medium">Confirm Password</label>
            <input type="password" required minLength={12} value={form.confirmPassword} onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))} className={inputCls} autoComplete="new-password" />
          </div>
        </div>
        {msg && <p className={`text-xs ${isError ? 'text-red-400' : 'text-green-400'}`}>{isError ? msg.slice(6) : msg}</p>}
        <button type="submit" disabled={saving} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors">
          {saving ? 'Updating...' : 'Change Password'}
        </button>
      </form>
    </div>
  );
}

// ── Notification preferences ─────────────────────────────────────────────────

function NotificationsSection() {
  const [optOut, setOptOut] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/notifications/preferences')
      .then(({ data }) => setOptOut(!!data.optOut))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const toggle = async () => {
    const next = !optOut;
    setSaving(true); setMsg('');
    try {
      await api.put('/notifications/preferences', { optOut: next });
      setOptOut(next);
      setMsg(next ? 'You will no longer be included in notifications about your resources.' : 'Notifications about your resources are on.');
    } catch (e) {
      setMsg('error:' + (e.response?.data?.error || 'Failed to save'));
    } finally { setSaving(false); }
  };

  const isError = msg.startsWith('error:');

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-orange-500/10 rounded-xl flex items-center justify-center">
          <svg className="w-4.5 h-4.5 text-orange-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Notifications</h2>
          <p className="text-xs text-gray-500">Discord alerts about your own VMs and backups</p>
        </div>
      </div>
      <label className={`flex items-center justify-between gap-3 ${loaded ? 'cursor-pointer' : 'opacity-50'}`}>
        <span className="text-sm text-gray-300">Include my resources in Discord notifications</span>
        <input
          type="checkbox"
          checked={!optOut}
          disabled={!loaded || saving}
          onChange={toggle}
          className="accent-blue-500 w-4 h-4"
        />
      </label>
      {msg && <p className={`text-xs ${isError ? 'text-red-400' : 'text-green-400'}`}>{isError ? msg.slice(6) : msg}</p>}
    </div>
  );
}

// ── Connection (client IP / proxy chain) ─────────────────────────────────────

// A wrong TRUST_PROXY makes the portal see the reverse proxy's address instead
// of the user's, which silently breaks per-IP login lockout and the audit log's
// IP column. Comparing this line against your real public IP diagnoses it.
function ConnectionSection() {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/health/client-ip')
      .then(({ data }) => setInfo(data))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  const mismatch = !!info && (info.suspicious || info.agrees === false);
  const confirmed = !!info && info.agrees === true && !info.suspicious;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 border border-gray-700 bg-gray-800 flex items-center justify-center">
          <svg aria-hidden="true" focusable="false" className="w-4.5 h-4.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
          </svg>
        </div>
        <div>
          <h2 className="aaris-display text-sm text-white">Connection</h2>
          <p className="text-xs text-gray-500">The address this portal sees you coming from</p>
        </div>
      </div>

      {loading ? (
        <div className="h-5 bg-gray-800/60 rounded animate-pulse" />
      ) : failed || !info ? (
        <p className="text-xs text-gray-600 italic">Connection details are unavailable right now.</p>
      ) : (
        <>
          <p className="text-sm text-gray-400 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span>Your address as seen by the portal:</span>
            <span className="font-mono text-white select-all">{info.ip || 'unknown'}</span>
            <span className="text-gray-700">·</span>
            <span>X-Forwarded-For chain:</span>
            <span className="font-mono text-white">{info.hops} hop{info.hops === 1 ? '' : 's'}</span>
            <span className="text-gray-700">·</span>
            <span className="font-mono text-white">TRUST_PROXY={info.trustProxy}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ring-1 ${
              mismatch
                ? 'bg-yellow-500/10 ring-yellow-500/30 text-yellow-400'
                : confirmed
                  ? 'bg-green-500/10 ring-green-500/20 text-green-400'
                  : 'bg-gray-800 ring-gray-700 text-gray-400'
            }`}>
              {mismatch ? 'Mismatch' : confirmed ? 'Match' : 'Unverified'}
            </span>
          </p>

          {mismatch ? (
            <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-xl p-4 flex items-start gap-3">
              <svg aria-hidden="true" focusable="false" className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <div>
                <p className="text-sm text-yellow-300 font-medium">TRUST_PROXY does not match this deployment</p>
                <p className="text-xs text-yellow-400/70 mt-0.5">{info.reason}</p>
                <p className="text-xs text-yellow-400/70 mt-1.5">
                  Ask an admin to set <code className="font-mono">TRUST_PROXY</code> to the number of proxies in front of
                  the backend — see “Counting your proxies” in the README.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              If that is not your real public IP address, <code className="font-mono text-gray-400">TRUST_PROXY</code> does
              not match the number of proxies in front of the portal — per-IP login lockout and the audit log's IP column
              are then recording a proxy instead of you. Tell an admin.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Two-Factor ───────────────────────────────────────────────────────────────

function TwoFactorSection({ user, setUser }) {
  const [step, setStep] = useState('idle');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');

  const startSetup = async () => {
    setError(''); setSuccess(''); setSaving(true);
    try {
      const { data } = await api.post('/auth/2fa/setup');
      setQrDataUrl(data.qrDataUrl);
      setSecret(data.secret);
      setStep('setup');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to start setup');
    } finally { setSaving(false); }
  };

  const enable = async (e) => {
    e.preventDefault(); setError(''); setSaving(true);
    try {
      await api.post('/auth/2fa/enable', { code });
      setUser(u => ({ ...u, twoFactorEnabled: true, twoFactorSetupRequired: false }));
      setStep('idle'); setCode('');
      setSuccess('Two-factor authentication enabled.');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to enable 2FA');
    } finally { setSaving(false); }
  };

  const disable = async (e) => {
    e.preventDefault(); setError(''); setSaving(true);
    try {
      await api.post('/auth/2fa/disable', { code });
      setUser(u => ({ ...u, twoFactorEnabled: false }));
      setStep('idle'); setCode('');
      setSuccess('Two-factor authentication disabled.');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to disable 2FA');
    } finally { setSaving(false); }
  };

  const cancel = () => { setStep('idle'); setCode(''); setError(''); };

  const isRequired = user?.require2fa && !user?.twoFactorEnabled;

  return (
    <div className={`bg-gray-900 border rounded-2xl p-5 space-y-4 ${isRequired ? 'border-yellow-700/50' : 'border-gray-800'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${user?.twoFactorEnabled ? 'bg-green-500/10' : 'bg-gray-800'}`}>
            <svg className={`w-4.5 h-4.5 ${user?.twoFactorEnabled ? 'text-green-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Two-Factor Authentication</h2>
            <p className="text-xs text-gray-500">
              {user?.twoFactorEnabled ? 'Your account is protected with an authenticator app' : 'Add an extra layer of security'}
            </p>
          </div>
        </div>
        <span className={`text-xs px-2.5 py-1 rounded-full ring-1 ${user?.twoFactorEnabled ? 'bg-green-500/10 ring-green-500/20 text-green-400' : 'bg-gray-800 ring-gray-700 text-gray-400'}`}>
          {user?.twoFactorEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      {success && (
        <p className="text-xs text-green-400 bg-green-900/20 border border-green-800/30 rounded-xl p-3 flex items-center gap-2">
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          {success}
        </p>
      )}

      {step === 'idle' && (
        user?.twoFactorEnabled ? (
          user?.require2fa ? (
            <p className="text-xs text-gray-500">Your administrator requires 2FA on this account, so it cannot be disabled here.</p>
          ) : (
            <button
              onClick={() => { setStep('disable'); setError(''); setSuccess(''); }}
              className="text-sm text-red-400 hover:text-red-300 border border-red-800/50 hover:border-red-600 px-4 py-2 rounded-xl transition-colors"
            >
              Disable 2FA
            </button>
          )
        ) : (
          <button
            onClick={startSetup}
            disabled={saving}
            className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl font-medium transition-colors shadow-lg shadow-blue-600/20"
          >
            {saving ? 'Setting up...' : 'Enable 2FA'}
          </button>
        )
      )}

      {step === 'setup' && (
        <form onSubmit={enable} className="space-y-4 border-t border-gray-700/50 pt-4">
          <div>
            <p className="text-xs text-gray-400 mb-3">
              1. Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
            </p>
            <div className="flex justify-center bg-white rounded-xl p-3 w-fit">
              <img src={qrDataUrl} alt="2FA QR Code" className="w-44 h-44" />
            </div>
            <details className="mt-3">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">Can't scan? Enter code manually</summary>
              <p className="text-xs font-mono text-gray-300 bg-gray-800 rounded-lg p-2.5 mt-2 break-all select-all">{secret}</p>
            </details>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-2">2. Enter the 6-digit code from your app to confirm</p>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code"
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className={`${inputCls} text-center tracking-[0.3em] font-mono text-lg`}
              placeholder="000000" maxLength={6} autoFocus
            />
          </div>
          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={saving || code.length !== 6} className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors">
              {saving ? 'Activating...' : 'Activate 2FA'}
            </button>
            <button type="button" onClick={cancel} className="px-5 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-xl transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {step === 'disable' && (
        <form onSubmit={disable} className="space-y-3 border-t border-gray-700/50 pt-4">
          <p className="text-xs text-gray-400">Enter your current authenticator code to disable 2FA</p>
          <input
            type="text" inputMode="numeric" autoComplete="one-time-code"
            value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className={`${inputCls} text-center tracking-[0.3em] font-mono text-lg`}
            placeholder="000000" maxLength={6} autoFocus
          />
          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={saving || code.length !== 6} className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors">
              {saving ? 'Disabling...' : 'Confirm Disable'}
            </button>
            <button type="button" onClick={cancel} className="px-5 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-xl transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Personal API Tokens ──────────────────────────────────────────────────────

const EXPIRY_OPTIONS = [
  { label: 'No expiry', value: '' },
  { label: '7 days', value: '7' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: '1 year', value: '365' },
];

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? v : d.toLocaleString();
}

function ApiTokensSection() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState(''); // plaintext, shown once
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState('');
  const [scopes, setScopes] = useState(['read']);

  const load = async () => {
    try {
      const { data } = await api.get('/auth/tokens');
      setTokens(data);
    } catch (e) {
      setMsg('error:' + (e.response?.data?.error || 'Failed to load API tokens'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    setCreating(true); setMsg('');
    try {
      const { data } = await api.post('/auth/tokens', {
        name: name.trim(),
        expiresInDays: expiry === '' ? null : Number(expiry),
        scopes,
      });
      setNewToken(data.token);
      setCopied(false);
      setName(''); setExpiry(''); setScopes(['read']);
      load();
    } catch (e) {
      setMsg('error:' + (e.response?.data?.error || 'Failed to create token'));
    } finally {
      setCreating(false);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setMsg('error:Copy failed — select the token and copy it manually');
    }
  };

  const revoke = async (token) => {
    if (!window.confirm(`Revoke "${token.name}"? Any script using it will immediately lose access.`)) return;
    setMsg('');
    try {
      await api.delete(`/auth/tokens/${token.id}`);
      setMsg('Token revoked');
      load();
    } catch (e) {
      setMsg('error:' + (e.response?.data?.error || 'Failed to revoke token'));
    }
  };

  const isError = msg.startsWith('error:');

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 border border-gray-700 bg-gray-800 flex items-center justify-center">
          <svg aria-hidden="true" focusable="false" className="w-4.5 h-4.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
          </svg>
        </div>
        <div>
          <h2 className="aaris-display text-sm text-white">API Tokens</h2>
          <p className="text-xs text-gray-500">Authenticate scripts and automation without your session cookie</p>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        A token is limited by both the scopes selected here and your live permissions. Send it as
        <code className="mx-1 px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 font-mono text-[11px]">Authorization: Bearer &lt;token&gt;</code>.
        Tokens cannot manage tokens, passwords, or 2FA.
      </p>

      {/* One-time token reveal */}
      {newToken && (
        <div className="bg-green-900/20 border border-green-800/40 rounded-xl p-4 space-y-2">
          <p className="text-xs text-green-300 font-medium">Your new token — copy it now. You won't be able to see it again.</p>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 font-mono text-[11px] text-green-200 bg-gray-950/60 rounded-lg p-2.5 break-all select-all">{newToken}</code>
            <button
              type="button"
              onClick={copyToken}
              className="shrink-0 px-3 text-xs bg-green-700 hover:bg-green-600 text-white rounded-lg transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button type="button" onClick={() => setNewToken('')} className="text-xs text-gray-400 hover:text-gray-200">
            I've saved it — dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={create} className="space-y-3 border-t border-gray-800 pt-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <label htmlFor="token-name" className="block text-xs text-gray-500 mb-1.5 font-medium">Token name</label>
          <input
            id="token-name"
            type="text"
            required
            maxLength={64}
            placeholder="ci-deploy"
            value={name}
            onChange={e => setName(e.target.value)}
            className={inputCls}
          />
        </div>
        <div className="sm:w-40">
          <label htmlFor="token-expiry" className="block text-xs text-gray-500 mb-1.5 font-medium">Expiry</label>
          <select
            id="token-expiry"
            value={expiry}
            onChange={e => setExpiry(e.target.value)}
            className={inputCls}
          >
            {EXPIRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors shrink-0"
        >
          {creating ? 'Creating...' : 'Create Token'}
        </button>
        </div>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="text-xs text-gray-500 mb-2">Scopes</legend>
          {[
            ['read', 'Read data'],
            ['vm:operate', 'Operate VMs'],
            ['infrastructure:write', 'Infrastructure writes'],
            ...(user?.isAdmin ? [['admin', 'Admin API']] : []),
          ].map(([value, label]) => <label key={value} className="text-xs text-gray-300 flex items-center gap-1.5"><input type="checkbox" checked={scopes.includes(value)} disabled={value === 'read'} onChange={(event) => setScopes((current) => event.target.checked ? [...current, value] : current.filter((scope) => scope !== value))} />{label}</label>)}
        </fieldset>
      </form>

      {msg && <p role={isError ? 'alert' : 'status'} aria-live={isError ? undefined : 'polite'} className={`text-xs ${isError ? 'text-red-400' : 'text-green-400'}`}>{isError ? msg.slice(6) : msg}</p>}

      {/* List */}
      <div className="border-t border-gray-800 pt-4">
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map(i => <div key={i} className="h-12 bg-gray-800/60 rounded-lg animate-pulse" />)}
          </div>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No API tokens yet.</p>
        ) : (
          <ul className="space-y-2">
            {tokens.map(t => (
              <li key={t.id} className="flex items-center justify-between gap-3 bg-gray-800/50 rounded-lg px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-white truncate font-mono">{t.name}</p>
                    {t.expired && <span className="text-[10px] bg-red-900 text-red-300 px-1.5 py-0.5 rounded uppercase tracking-wide">Expired</span>}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Created {fmtDate(t.createdAt)} · Expires {t.expiresAt ? fmtDate(t.expiresAt) : 'never'} · Last used {fmtDate(t.lastUsedAt)}
                  </p>
                  <p className="text-[10px] text-blue-400 mt-1">{(t.scopes || ['read']).join(' · ')}</p>
                </div>
                <button
                  onClick={() => revoke(t)}
                  className="shrink-0 text-xs px-3 py-1 bg-red-800 hover:bg-red-700 text-white rounded transition-colors"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
