import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { startAuthentication } from '@simplewebauthn/browser';
import api from '../api.js';
import AuthScreen, { authLabelCls as labelCls, authInputCls as inputCls, authBtnCls as btnCls } from '../components/AuthScreen.jsx';

export default function Login() {
  useDocumentTitle('Sign In');
  const { login, verifyTwoFactor, setUser } = useAuth();
  const navigate = useNavigate();
  const [step, setStep]     = useState('credentials');
  const [form, setForm]     = useState({ username: '', password: '' });
  const [code, setCode]     = useState('');
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [methods, setMethods] = useState([]);
  const codeRef = useRef(null);

  useEffect(() => {
    if (step === 'totp') codeRef.current?.focus();
  }, [step]);

  const submitCredentials = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const result = await login(form.username, form.password);
      if (result.requiresTwoFactor) { setMethods(result.methods || ['totp']); setStep('totp'); }
      else if (result.twoFactorSetupRequired) navigate('/account', { replace: true });
      else navigate('/welcome', { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || 'Login failed');
    } finally { setLoading(false); }
  };

  const verifyPasskey = async () => {
    setError(''); setLoading(true);
    try {
      const { data: optionsJSON } = await api.post('/auth/passkeys/authentication/options');
      const credential = await startAuthentication({ optionsJSON });
      const { data } = await api.post('/auth/passkeys/authentication/verify', { credential });
      setUser(data);
      navigate('/welcome', { replace: true });
    } catch (e) { setError(e.response?.data?.error || e.message || 'Passkey verification failed'); }
    finally { setLoading(false); }
  };

  const submitRecovery = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const { data } = await api.post('/auth/verify-recovery-code', { code });
      setUser(data);
      navigate('/welcome', { replace: true });
    } catch (err) { setError(err.response?.data?.error || 'Invalid recovery code'); setCode(''); }
    finally { setLoading(false); }
  };

  const submitTotp = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await verifyTwoFactor(code);
      navigate('/welcome', { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || 'Invalid code');
      setCode('');
    } finally { setLoading(false); }
  };

  const titles = { recovery: 'Recovery Code', totp: 'Two-Factor Verification' };

  return (
    <AuthScreen
      step={step === 'credentials' ? '01' : '02'}
      title={titles[step] || 'Authenticate'}
      footerNote="No tracking"
    >
      <>
        {step === 'credentials' ? (
          <form onSubmit={submitCredentials} className="border border-gray-800 bg-gray-900 p-6 space-y-4">
            <div>
              <label className={labelCls}>Username</label>
              <input
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
              <label className={labelCls}>Password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                className={inputCls}
                placeholder="••••••••"
                required
              />
            </div>
            {error && (
              <p className="flex items-start gap-2 text-xs text-red-400 bg-red-900/20 border border-red-800/40 px-3 py-2.5 font-mono">
                <span className="aaris-led aaris-led--error mt-1" /> {error}
              </p>
            )}
            <button type="submit" disabled={loading} className={btnCls}>
              {loading ? 'Authenticating…' : 'Sign In →'}
            </button>
          </form>
        ) : step === 'totp' ? (
          <form onSubmit={submitTotp} className="border border-gray-800 bg-gray-900 p-6 space-y-4">
            <input type="hidden" name="username" autoComplete="username" value={form.username} />
            <input type="hidden" name="password" autoComplete="current-password" value={form.password} />
            <p className="text-xs text-gray-500 font-mono leading-relaxed">
              Enter the 6-digit code from your authenticator app.
            </p>
            <div>
              <label htmlFor="otp-code" className={labelCls}>Authentication Code</label>
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
                className={`${inputCls} text-center tracking-[0.5em] text-lg`}
                placeholder="000000"
                maxLength={6}
                required
              />
            </div>
            {error && (
              <p className="flex items-start gap-2 text-xs text-red-400 bg-red-900/20 border border-red-800/40 px-3 py-2.5 font-mono">
                <span className="aaris-led aaris-led--error mt-1" /> {error}
              </p>
            )}
            <button type="submit" disabled={loading || code.length !== 6} className={btnCls}>
              {loading ? 'Verifying…' : 'Verify →'}
            </button>
            {methods.includes('passkey') && <button type="button" disabled={loading} onClick={verifyPasskey} className="w-full border border-gray-700 text-gray-200 font-mono text-xs uppercase tracking-[0.1em] py-3 hover:border-orange-600">Use a passkey</button>}
            {methods.includes('recovery') && <button type="button" onClick={() => { setStep('recovery'); setCode(''); setError(''); }} className="w-full font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500 hover:text-gray-300">Use a recovery code</button>}
            <button
              type="button"
              onClick={() => { setStep('credentials'); setError(''); setCode(''); }}
              className="w-full font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500 hover:text-gray-300 py-1 transition-colors"
            >
              {'←'} Back to login
            </button>
          </form>
        ) : (
          <form onSubmit={submitRecovery} className="border border-gray-800 bg-gray-900 p-6 space-y-4">
            <p className="text-xs text-gray-500 font-mono leading-relaxed">Enter one unused recovery code. It will be permanently consumed.</p>
            <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 19))} className={inputCls} autoComplete="one-time-code" placeholder="ABCD-EF12-3456-7890" required autoFocus />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button type="submit" disabled={loading || code.length < 16} className={btnCls}>{loading ? 'Verifying…' : 'Use Recovery Code →'}</button>
            <button type="button" onClick={() => { setStep('totp'); setCode(''); setError(''); }} className="w-full font-mono text-[10px] uppercase tracking-[0.14em] text-gray-500 hover:text-gray-300">← Back</button>
          </form>
        )}
      </>
    </AuthScreen>
  );
}
