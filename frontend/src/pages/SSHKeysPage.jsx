import { useState, useEffect } from 'react';
import Layout from '../components/Layout.jsx';
import Modal from '../components/Modal.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import api from '../api.js';
import { isUsableKey, unusableKeyReason, NO_PUBLIC_KEY_LABEL } from '../utils/cloudInitCredentials.js';

export default function SSHKeysPage() {
  useDocumentTitle('SSH Keys');
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const load = async () => {
    try {
      const r = await api.get('/ssh/keys');
      setKeys(r.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const deleteKey = async (id, name) => {
    if (!confirm(`Delete SSH key "${name}"?`)) return;
    try {
      await api.delete(`/ssh/keys/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="aaris-display text-lg text-gray-100">SSH Keys</h1>
            <p className="text-sm text-gray-500 mt-0.5">{keys.length} key{keys.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            + Add Key
          </button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2].map(i => <div key={i} className="h-16 bg-gray-900 rounded-xl animate-pulse" />)}
          </div>
        ) : keys.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
            <p>No SSH keys yet.</p>
            <p className="text-sm mt-1">Add a private key to connect to your VMs via SSH.</p>
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Public Key</th>
                  <th className="text-left px-4 py-3">Added</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{k.name}</td>
                    <td className="px-4 py-3 text-xs max-w-xs">
                      {isUsableKey(k) ? (
                        <span className="text-gray-400 font-mono block truncate">{k.public_key}</span>
                      ) : (
                        // Without a public key, cloud-init has nothing to inject, so
                        // this key can't set up login on a VM you deploy. The reason
                        // stays on the row — the warning shown when the key was added
                        // is long gone by the time it matters.
                        <div>
                          <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium">
                            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                            </svg>
                            {NO_PUBLIC_KEY_LABEL}
                          </span>
                          <span className="block text-[11px] text-gray-500 mt-0.5">
                            Can’t set up key-based login when you deploy a VM. {unusableKeyReason(k)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(k.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => deleteKey(k.id, k.name)}
                        className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {addOpen && <AddKeyModal onClose={() => setAddOpen(false)} onAdded={load} />}
      </div>
    </Layout>
  );
}

function AddKeyModal({ onClose, onAdded }) {
  const [form, setForm] = useState({ name: '', privateKey: '', publicKey: '', passphrase: '' });
  const isPPK = form.privateKey.includes('PuTTY-User-Key-File');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setWarning('');
    try {
      const r = await api.post('/ssh/keys', form);
      onAdded();
      // If the key has no usable public key, keep the dialog open to tell the
      // user it won't work for cloud-init provisioning; otherwise we're done.
      if (r.data?.warning) {
        setWarning(r.data.warning);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to add key');
    } finally {
      setSaving(false);
    }
  };

  if (warning) {
    return (
      <Modal title="Key added — missing public key" onClose={onClose} size="md">
        <div className="p-5 space-y-4">
          <div className="flex gap-3 text-sm text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg p-3">
            <svg className="w-5 h-5 flex-shrink-0 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <p>{warning}</p>
          </div>
          <button onClick={onClose} className={btnCls}>Done</button>
        </div>
      </Modal>
    );
  }

  const handleFileUpload = (field) => (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm(f => ({ ...f, [field]: reader.result }));
    reader.readAsText(file);
  };

  return (
    <Modal title="Add SSH Key" onClose={onClose} size="md">
      <form onSubmit={submit} className="p-5 space-y-4">
        <Field label="Key Name">
          <input
            type="text"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className={inputCls}
            placeholder="my-server-key"
            autoFocus
          />
        </Field>

        <Field label="Private Key (OpenSSH, PEM, or PuTTY PPK)">
          <textarea
            required
            value={form.privateKey}
            onChange={e => setForm(f => ({ ...f, privateKey: e.target.value }))}
            className={`${inputCls} font-mono text-xs h-32 resize-none`}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;&#10;PuTTY PPK files are also supported."
          />
          <label className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 cursor-pointer transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            Upload file
            <input type="file" className="hidden" accept=".pem,.key,.ppk,*" onChange={handleFileUpload('privateKey')} />
          </label>
        </Field>

        {isPPK && (
          <Field label="PPK Passphrase (if encrypted)">
            <input
              type="password"
              value={form.passphrase}
              onChange={e => setForm(f => ({ ...f, passphrase: e.target.value }))}
              className={inputCls}
              placeholder="Leave empty if the key is not encrypted"
            />
            <p className="text-xs text-gray-500 mt-1">PPK keys are converted to OpenSSH format on upload.</p>
          </Field>
        )}

        <Field label="Public Key">
          <p className="text-xs text-gray-500 -mt-1 mb-1.5">
            Used to set up key-based login when you deploy a VM (cloud-init). Leave blank and we'll derive it from your private key when possible.
          </p>
          <textarea
            value={form.publicKey}
            onChange={e => setForm(f => ({ ...f, publicKey: e.target.value }))}
            className={`${inputCls} font-mono text-xs h-16 resize-none`}
            placeholder="ssh-ed25519 AAAA... (auto-derived from your private key if left blank)"
          />
          <label className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 cursor-pointer transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            Upload file
            <input type="file" className="hidden" onChange={handleFileUpload('publicKey')} />
          </label>
        </Field>

        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <button type="submit" disabled={saving} className={btnCls}>
          {saving ? 'Adding...' : 'Add Key'}
        </button>
      </form>
    </Modal>
  );
}

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';
const btnCls = 'w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors';

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
