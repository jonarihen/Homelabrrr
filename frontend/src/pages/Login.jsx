import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';

export default function Login() {
  useDocumentTitle('Sign In');
  const { login, verifyTwoFactor } = useAuth();
  const navigate = useNavigate();
  const [step, setStep]     = useState('credentials');
  const [form, setForm]     = useState({ username: '', password: '' });
  const [code, setCode]     = useState('');
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const codeRef = useRef(null);

  useEffect(() => {
    if (step === 'totp') codeRef.current?.focus();
  }, [step]);

  const submitCredentials = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const result = await login(form.username, form.password);
      if (result.requiresTwoFactor) setStep('totp');
      else if (result.twoFactorSetupRequired) navigate('/account', { replace: true });
      else navigate('/dashboard', { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || 'Login failed');
    } finally { setLoading(false); }
  };

  const submitTotp = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await verifyTwoFactor(code);
      navigate('/dashboard', { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || 'Invalid code');
      setCode('');
    } finally { setLoading(false); }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      {/* Background decoration */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-600/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-purple-600/5 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-sm relative">
        {/* Logo & heading */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/20">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">VM Manager</h1>
          <p className="text-gray-500 text-sm mt-1.5">
            {step === 'totp' ? 'Two-factor authentication' : 'Sign in to your account'}
          </p>
        </div>

        {step === 'credentials' ? (
          <form onSubmit={submitCredentials} className="bg-gray-900/80 border border-gray-800/50 rounded-2xl p-6 space-y-4 backdrop-blur-sm shadow-xl shadow-black/20">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Username</label>
              <input
                type="text"
                autoComplete="username"
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                className={inputCls}
                placeholder="Enter username"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                className={inputCls}
                placeholder="Enter password"
                required
              />
            </div>
            {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-3 text-sm font-semibold transition-all shadow-lg shadow-blue-600/20 hover:shadow-blue-600/30"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitTotp} className="bg-gray-900/80 border border-gray-800/50 rounded-2xl p-6 space-y-4 backdrop-blur-sm shadow-xl shadow-black/20">
            <input type="hidden" name="username" autoComplete="username" value={form.username} />
            <input type="hidden" name="password" autoComplete="current-password" value={form.password} />
            <div className="text-center pb-2">
              <div className="w-14 h-14 bg-blue-500/10 ring-1 ring-blue-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">
                Enter the 6-digit code from your<br />authenticator app
              </p>
            </div>
            <div>
              <label htmlFor="otp-code" className="block text-xs text-gray-400 mb-1.5 font-medium">Authentication Code</label>
              <input
                ref={codeRef}
                id="otp-code"
                name="otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className={`${inputCls} text-center tracking-[0.3em] text-lg font-mono`}
                placeholder="000000"
                maxLength={6}
                required
              />
            </div>
            {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-3 text-sm font-semibold transition-all shadow-lg shadow-blue-600/20 hover:shadow-blue-600/30"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('credentials'); setError(''); setCode(''); }}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 py-1 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              Back to login
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
