import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';

const labelCls = 'block text-[10px] font-mono uppercase tracking-[0.14em] text-gray-500 mb-2';
const inputCls = 'w-full bg-[#0b0d11] border border-gray-700 px-3.5 py-3 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:border-orange-600 transition-colors';
const btnCls = 'w-full border border-orange-600 bg-orange-600 text-[#0e1014] font-mono text-xs font-semibold uppercase tracking-[0.14em] py-3.5 hover:bg-orange-500 hover:border-orange-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

function Tag({ children }) {
  return (
    <span className="inline-block font-mono text-[10px] uppercase tracking-[0.1em] text-gray-300 border border-gray-700 px-2 py-0.5">
      {children}
    </span>
  );
}

export default function AcceptInvite() {
  useDocumentTitle('Accept Invite');
  const { token } = useParams();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [state, setState]   = useState('loading'); // loading | invalid | ready
  const [invite, setInvite] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm]     = useState({ username: '', password: '', confirm: '' });
  const [error, setError]   = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(`/auth/invite/${encodeURIComponent(token)}`)
      .then(r => { if (!cancelled) { setInvite(r.data); setState('ready'); } })
      .catch(e => { if (!cancelled) { setLoadError(e.response?.data?.error || 'This invite is not valid.'); setState('invalid'); } });
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 12) { setError('Password must be at least 12 characters'); return; }
    if (form.password !== form.confirm) { setError('Passwords do not match'); return; }
    setSubmitting(true);
    try {
      const r = await api.post(`/auth/invite/${encodeURIComponent(token)}`, {
        username: form.username,
        password: form.password,
      });
      setUser(r.data);
      if (r.data.twoFactorSetupRequired) navigate('/account', { replace: true });
      else navigate('/welcome', { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create account');
      // A 410/404 means the invite went stale mid-flow — flip to the error view.
      const status = e.response?.status;
      if (status === 410 || status === 404) {
        setLoadError(e.response?.data?.error || 'This invite is no longer valid.');
        setState('invalid');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const preset = invite?.preset || {};

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      <div className="w-full max-w-sm relative">
        {/* Wordmark / identity plate */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 border border-orange-600 flex items-center justify-center text-orange-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <rect x="2" y="3" width="20" height="14" rx="0" />
                <path d="M8 21h8M12 17v4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="leading-none">
              <div className="aaris-display text-lg text-gray-100">VM Manager</div>
              <div className="aaris-meta mt-1 text-[10px]">Operator Console</div>
            </div>
          </div>
          <div className="h-px bg-gray-700" />
        </div>

        <div className="flex items-baseline gap-3 mb-4">
          <span className="font-mono text-xs font-semibold text-orange-600 tracking-[0.12em]">01</span>
          <h1 className="aaris-display text-sm text-gray-300">Claim Invite</h1>
        </div>

        {state === 'loading' && (
          <div className="border border-gray-800 bg-gray-900 p-6 font-mono text-xs text-gray-500 flex items-center gap-2">
            <span className="aaris-led aaris-led--warning aaris-led--pulse" /> Validating invite…
          </div>
        )}

        {state === 'invalid' && (
          <div className="border border-gray-800 bg-gray-900 p-6 space-y-4">
            <p className="flex items-start gap-2 text-xs text-red-400 bg-red-900/20 border border-red-800/40 px-3 py-2.5 font-mono">
              <span className="aaris-led aaris-led--error mt-1" /> {loadError}
            </p>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              className={btnCls}
            >
              Go to Sign In →
            </button>
          </div>
        )}

        {state === 'ready' && (
          <form onSubmit={submit} className="border border-gray-800 bg-gray-900 p-6 space-y-4">
            {/* Preset summary — what this invite grants */}
            <div className="border border-gray-800 bg-[#0b0d11] p-3 space-y-2">
              <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-gray-500">Access Preset</p>
              <div className="flex flex-wrap gap-1.5">
                {preset.isAdmin && <Tag>Admin</Tag>}
                <Tag>{preset.role ? `Role · ${preset.role.name}` : 'No role'}</Tag>
                {invite.requires2fa && <Tag>2FA required</Tag>}
              </div>
              {preset.grantedPermissions?.length > 0 && (
                <p className="text-[11px] font-mono text-gray-500">
                  {preset.grantedPermissions.length} permission{preset.grantedPermissions.length !== 1 ? 's' : ''} granted
                </p>
              )}
              {preset.vlans?.length > 0 && (
                <p className="text-[11px] font-mono text-gray-500">
                  VLAN access: {preset.vlans.map(v => `${v.name} (${v.tag})`).join(', ')}
                </p>
              )}
              {(preset.quotas?.maxCores != null || preset.quotas?.maxMemoryGb != null || preset.quotas?.maxStorageGb != null) && (
                <p className="text-[11px] font-mono text-gray-500">
                  Quota:
                  {preset.quotas.maxCores != null ? ` ${preset.quotas.maxCores} cores` : ''}
                  {preset.quotas.maxMemoryGb != null ? ` · ${preset.quotas.maxMemoryGb}GB RAM` : ''}
                  {preset.quotas.maxStorageGb != null ? ` · ${preset.quotas.maxStorageGb}GB disk` : ''}
                </p>
              )}
              {invite.expiresAt && (
                <p className="text-[11px] font-mono text-gray-600">
                  Expires {new Date(invite.expiresAt).toLocaleString()}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="invite-username" className={labelCls}>Choose a username</label>
              <input
                id="invite-username"
                type="text"
                autoComplete="username"
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                className={inputCls}
                placeholder="operator"
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="invite-password" className={labelCls}>Password (min 12 characters)</label>
              <input
                id="invite-password"
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                className={inputCls}
                placeholder="••••••••"
                required
              />
            </div>
            <div>
              <label htmlFor="invite-confirm" className={labelCls}>Confirm password</label>
              <input
                id="invite-confirm"
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={form.confirm}
                onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
                className={inputCls}
                placeholder="••••••••"
                required
              />
            </div>

            {invite.requires2fa && (
              <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                After creating your account you'll be required to set up two-factor authentication before you can continue.
              </p>
            )}

            {error && (
              <p className="flex items-start gap-2 text-xs text-red-400 bg-red-900/20 border border-red-800/40 px-3 py-2.5 font-mono">
                <span className="aaris-led aaris-led--error mt-1" /> {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className={btnCls}>
              {submitting ? 'Creating account…' : 'Create Account →'}
            </button>
          </form>
        )}

        {/* Status footer */}
        <div className="mt-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-gray-600">
          <span className="flex items-center gap-1.5"><span className="aaris-led aaris-led--ok" /> Session · TLS</span>
          <span>Single-use invite</span>
        </div>
      </div>
    </div>
  );
}
