import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import api from '../api.js';
import { displayNode, routeNode } from '../utils/nodeRef.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all';
const tabCls = (active) => `px-4 py-2 text-sm font-medium rounded-lg transition-all ${active ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`;

export default function ProvisionPage() {
  useDocumentTitle('New VM');
  const { user } = useAuth();
  const canTemplate = user?.isAdmin || user?.canProvision;
  const canCreate = user?.isAdmin;
  const showTabs = canTemplate && canCreate;
  const [tab, setTab] = useState(() => canTemplate ? 'template' : 'create');

  if (!canTemplate && !canCreate) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-3xl mx-auto">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-white font-semibold">Provisioning access required</p>
            <p className="text-sm text-gray-500 mt-2">
              Ask an admin to grant template provisioning access if you need to create VMs through the portal.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="aaris-display text-xl text-gray-100">Create Virtual Machine</h1>
          <p className="text-sm text-gray-500 mt-1">
            {showTabs ? 'Provision a new VM from a template or create one from scratch'
              : canCreate ? 'Create a new VM with custom hardware settings'
              : 'Provision a new VM from a template'}
          </p>
        </div>

        {showTabs && (
          <div className="flex gap-1 bg-gray-900 rounded-xl p-1 w-fit">
            <button onClick={() => setTab('template')} className={tabCls(tab === 'template')}>
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.5a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                </svg>
                Clone Template
              </span>
            </button>
            <button onClick={() => setTab('create')} className={tabCls(tab === 'create')}>
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Create from Scratch
              </span>
            </button>
          </div>
        )}

        {tab === 'template' && canTemplate && <CloneForm />}
        {tab === 'create' && canCreate && <CreateForm />}

        <RecentProvisions />
      </div>
    </Layout>
  );
}

// ── Clone from Template ─────────────────────────────────────────────────────

function CloneForm() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [storages, setStorages] = useState([]);
  const [users, setUsers] = useState([]);
  const [vlans, setVlans] = useState([]);
  const [sshKeys, setSshKeys] = useState([]);
  const [form, setForm] = useState({ name: '', cores: '', memory: '', diskGb: '', storage: '', description: '', assignTo: '', vlanTag: '' });
  const [ci, setCi] = useState({ user: '', password: '', keyIds: [], ipMode: 'dhcp', ipAddress: '', ipGateway: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/provision/templates')
      .then(r => setTemplates(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
    api.get('/vms/my-vlans').then(r => setVlans(r.data)).catch(() => {});
    api.get('/ssh/keys').then(r => setSshKeys((r.data || []).filter(k => k.public_key))).catch(() => {});
    if (user?.isAdmin) {
      api.get('/admin/users').then(r => setUsers(r.data)).catch(() => {});
    }
  }, [user?.isAdmin]);

  // Fetch storages when a template is selected
  useEffect(() => {
    if (!selected) return;
    api.get(`/provision/nodes/${routeNode(selected)}/storages`)
      .then(r => setStorages(r.data))
      .catch(() => setStorages([]));
  }, [selected]);

  const selectTemplate = (t) => {
    setSelected(t);
    setForm({
      name: '',
      cores: t.default_cores,
      memory: Math.round(t.default_memory / 1024 * 10) / 10,
      diskGb: t.default_disk_gb,
      storage: t.default_storage,
      description: '',
    });
    setCi({ user: '', password: '', keyIds: [], ipMode: 'dhcp', ipAddress: '', ipGateway: '' });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await api.post('/provision/clone', {
        templateId: selected.id,
        name: form.name,
        cores: parseInt(form.cores),
        memoryGb: parseFloat(form.memory),
        diskGb: parseInt(form.diskGb),
        storage: form.storage,
        description: form.description,
        assignTo: form.assignTo || undefined,
        vlanTag: form.vlanTag || undefined,
        ...(selected.cloud_init ? {
          ciUser: ci.user || undefined,
          ciPassword: ci.password || undefined,
          sshKeyIds: ci.keyIds.length > 0 ? ci.keyIds : undefined,
          ipMode: ci.ipMode,
          ipAddress: ci.ipMode === 'static' ? ci.ipAddress : undefined,
          ipGateway: ci.ipMode === 'static' ? (ci.ipGateway || undefined) : undefined,
        } : {}),
      });
      navigate(`/vm/${routeNode(r.data)}/${r.data.vmid}`);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create VM');
    } finally { setSaving(false); }
  };

  const toggleKey = (id) => {
    setCi(c => ({ ...c, keyIds: c.keyIds.includes(id) ? c.keyIds.filter(k => k !== id) : [...c.keyIds, id] }));
  };

  if (loading) {
    return <div className="space-y-4">{[1, 2].map(i => <div key={i} className="h-24 bg-gray-900 rounded-2xl animate-pulse" />)}</div>;
  }

  if (templates.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
        <div className="w-14 h-14 bg-gray-800/50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        </div>
        <p className="text-gray-400 font-medium">No templates available</p>
        <p className="text-sm text-gray-600 mt-1">An admin needs to register VM templates first.</p>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Choose a template</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {templates.map(t => (
            <button
              key={t.id}
              onClick={() => selectTemplate(t)}
              className="bg-gray-900 border border-gray-800 rounded-2xl p-5 text-left hover:border-blue-500/50 hover:shadow-lg hover:shadow-blue-500/5 transition-all group"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center group-hover:bg-blue-500/20 transition-colors">
                  <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-white font-semibold group-hover:text-blue-400 transition-colors">{t.name}</h3>
                  <p className="text-xs text-gray-500 font-mono">{displayNode(t.node)} / VMID {t.vmid}</p>
                </div>
              </div>
              {t.description && <p className="text-xs text-gray-500 mb-2">{t.description}</p>}
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>{t.default_cores} cores</span>
                <span className="text-gray-700">|</span>
                <span>{t.default_memory >= 1024 ? `${(t.default_memory / 1024).toFixed(t.default_memory % 1024 === 0 ? 0 : 1)} GB` : `${t.default_memory} MB`} RAM</span>
                <span className="text-gray-700">|</span>
                <span>{t.default_disk_gb} GB disk</span>
                {t.cloud_init ? (
                  <>
                    <span className="text-gray-700">|</span>
                    <span className="text-cyan-400">Cloud-Init</span>
                  </>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => setSelected(null)}
        className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        Back to templates
      </button>

      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-5 pb-5 border-b border-gray-800">
          <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <div>
            <h3 className="text-white font-semibold">Cloning: {selected.name}</h3>
            <p className="text-xs text-gray-500 font-mono">{displayNode(selected.node)} / VMID {selected.vmid}</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">VM Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className={inputCls}
              placeholder="my-new-vm"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">CPU Cores</label>
              <input type="number" min="1" max="64" value={form.cores} onChange={e => setForm(f => ({ ...f, cores: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Memory (GB)</label>
              <input type="number" min="0.5" step="0.5" value={form.memory} onChange={e => setForm(f => ({ ...f, memory: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Disk (GB)</label>
              <input type="number" min="1" value={form.diskGb} onChange={e => setForm(f => ({ ...f, diskGb: e.target.value }))} className={inputCls} />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Storage</label>
            {storages.length > 0 ? (
              <select
                value={form.storage}
                onChange={e => setForm(f => ({ ...f, storage: e.target.value }))}
                className={inputCls}
              >
                {!storages.find(s => s.storage === form.storage) && form.storage && (
                  <option value={form.storage}>{form.storage}</option>
                )}
                {storages.filter(s => s.content?.includes('images')).map(s => (
                  <option key={s.storage} value={s.storage}>{s.storage} ({s.type})</option>
                ))}
              </select>
            ) : (
              <input type="text" value={form.storage} onChange={e => setForm(f => ({ ...f, storage: e.target.value }))} className={inputCls} placeholder="local-lvm" />
            )}
          </div>

          {vlans.length > 0 && (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">VLAN</label>
              <select value={form.vlanTag} onChange={e => setForm(f => ({ ...f, vlanTag: e.target.value }))} className={inputCls}>
                <option value="">No VLAN (untagged)</option>
                {vlans.map(v => <option key={v.id} value={v.tag}>{v.name} (Tag {v.tag})</option>)}
              </select>
            </div>
          )}

          {!!selected.cloud_init && (
            <div className="border border-gray-800 rounded-2xl p-4 space-y-4">
              <div>
                <p className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">Cloud-Init Setup</p>
                <p className="text-xs text-gray-600 mt-0.5">Guest account and network are applied on first boot.</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Username</label>
                  <input type="text" value={ci.user} onChange={e => setCi(c => ({ ...c, user: e.target.value }))} className={inputCls} placeholder="operator" autoComplete="off" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Password (optional)</label>
                  <input type="password" value={ci.password} onChange={e => setCi(c => ({ ...c, password: e.target.value }))} className={inputCls} placeholder="min. 8 characters" autoComplete="new-password" />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1.5 font-medium">SSH Keys</label>
                {sshKeys.length > 0 ? (
                  <div className="space-y-1.5">
                    {sshKeys.map(k => (
                      <label key={k.id} className="flex items-center gap-2.5 text-sm text-gray-300 cursor-pointer">
                        <input type="checkbox" checked={ci.keyIds.includes(k.id)} onChange={() => toggleKey(k.id)} className="accent-orange-600" />
                        <span className="font-mono text-xs">{k.name}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-600">No keys with a public key found — add one under SSH Keys to get key-based login.</p>
                )}
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 font-medium">Network</label>
                  <select value={ci.ipMode} onChange={e => setCi(c => ({ ...c, ipMode: e.target.value }))} className={inputCls}>
                    <option value="dhcp">DHCP</option>
                    <option value="static">Static IP</option>
                  </select>
                </div>
                {ci.ipMode === 'static' && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5 font-medium">IP / CIDR</label>
                      <input type="text" value={ci.ipAddress} onChange={e => setCi(c => ({ ...c, ipAddress: e.target.value }))} className={inputCls} placeholder="10.0.20.50/24" required />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5 font-medium">Gateway</label>
                      <input type="text" value={ci.ipGateway} onChange={e => setCi(c => ({ ...c, ipGateway: e.target.value }))} className={inputCls} placeholder="10.0.20.1" />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {user?.isAdmin && (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Assign to User</label>
              <select value={form.assignTo} onChange={e => setForm(f => ({ ...f, assignTo: e.target.value }))} className={inputCls}>
                <option value="">No assignment</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.username}{u.is_admin ? ' (admin)' : ''}</option>)}
              </select>
              <p className="text-xs text-gray-600 mt-1">Admins can see all VMs without an assignment.</p>
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Description (optional)</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className={`${inputCls} h-16 resize-none`}
              placeholder="What's this VM for?"
            />
          </div>

          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}

          <button
            type="submit"
            disabled={saving}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-3 text-sm font-semibold transition-all shadow-lg shadow-blue-600/20"
          >
            {saving ? 'Creating VM...' : 'Create VM'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Create from Scratch (admin only) ────────────────────────────────────────

function CreateForm() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [nodes, setNodes] = useState([]);
  const [storages, setStorages] = useState([]);
  const [isos, setIsos] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [users, setUsers] = useState([]);
  const [vlans, setVlans] = useState([]);
  const [form, setForm] = useState({
    node: '', name: '', cores: 2, memory: 2,
    diskSize: '20', storage: '', iso: '', bridge: 'vmbr0',
    ostype: 'l26', bios: 'seabios', scsihw: 'virtio-scsi-single',
    description: '', assignTo: '', vlanTag: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/provision/nodes').then(r => setNodes(r.data)).catch(() => {});
    api.get('/vms/my-vlans').then(r => setVlans(r.data)).catch(() => {});
    if (user?.isAdmin) {
      api.get('/admin/users').then(r => setUsers(r.data)).catch(() => {});
    }
  }, [user?.isAdmin]);

  useEffect(() => {
    if (!form.node) return;
    api.get(`/provision/nodes/${form.node}/storages`).then(r => {
      setStorages(r.data);
      if (!form.storage && r.data.length > 0) {
        const lvm = r.data.find(s => s.storage === 'local-lvm') || r.data[0];
        setForm(f => ({ ...f, storage: lvm.storage }));
      }
    }).catch(() => {});
    api.get(`/provision/nodes/${form.node}/networks`).then(r => {
      setBridges(r.data);
      if (r.data.length > 0 && !r.data.find(b => b.iface === form.bridge)) {
        setForm(f => ({ ...f, bridge: r.data[0].iface }));
      }
    }).catch(() => {});
  }, [form.node]);

  useEffect(() => {
    if (!form.node || !form.storage) return;
    const isoStorage = storages.find(s => s.content?.includes('iso'));
    if (isoStorage) {
      api.get(`/provision/nodes/${form.node}/isos/${isoStorage.storage}`).then(r => setIsos(r.data)).catch(() => setIsos([]));
    }
  }, [form.node, form.storage, storages]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const { memory, ...rest } = form;
      const r = await api.post('/provision/create', {
        ...rest,
        memoryGb: parseFloat(memory),
        diskSize: `${form.diskSize}G`,
        assignTo: form.assignTo || undefined,
        vlanTag: form.vlanTag || undefined,
      });
      navigate(`/vm/${routeNode(r.data)}/${r.data.vmid}`);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create VM');
    } finally { setSaving(false); }
  };

  const uniqueNodes = nodes;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center gap-3 mb-5 pb-5 border-b border-gray-800">
        <div className="w-10 h-10 bg-purple-500/10 rounded-xl flex items-center justify-center">
          <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </div>
        <div>
          <h3 className="text-white font-semibold">Create from Scratch</h3>
          <p className="text-xs text-gray-500">Full VM configuration with custom hardware settings</p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Node</label>
            <select value={form.node} onChange={e => setForm(f => ({ ...f, node: e.target.value }))} className={inputCls} required>
              <option value="">Select node...</option>
              {uniqueNodes.map(n => (
                <option key={routeNode(n)} value={routeNode(n)}>
                  {displayNode(n.node)}{n.hostName ? ` (${n.hostName})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">VM Name</label>
            <input type="text" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="my-vm" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">CPU Cores</label>
            <input type="number" min="1" max="128" value={form.cores} onChange={e => setForm(f => ({ ...f, cores: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Memory (GB)</label>
            <input type="number" min="0.5" step="0.5" value={form.memory} onChange={e => setForm(f => ({ ...f, memory: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Disk Size (GB)</label>
            <input type="number" min="1" value={form.diskSize} onChange={e => setForm(f => ({ ...f, diskSize: e.target.value }))} className={inputCls} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Storage</label>
            <select value={form.storage} onChange={e => setForm(f => ({ ...f, storage: e.target.value }))} className={inputCls}>
              <option value="">Select...</option>
              {storages.filter(s => s.content?.includes('images')).map(s => (
                <option key={s.storage} value={s.storage}>{s.storage} ({s.type})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Network Bridge</label>
            <select value={form.bridge} onChange={e => setForm(f => ({ ...f, bridge: e.target.value }))} className={inputCls}>
              {bridges.map(b => <option key={b.iface} value={b.iface}>{b.iface}{b.comments ? ` — ${b.comments}` : ''}</option>)}
              {bridges.length === 0 && <option value="vmbr0">vmbr0</option>}
            </select>
          </div>
        </div>

        {vlans.length > 0 && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">VLAN</label>
            <select value={form.vlanTag} onChange={e => setForm(f => ({ ...f, vlanTag: e.target.value }))} className={inputCls}>
              <option value="">No VLAN (untagged)</option>
              {vlans.map(v => <option key={v.id} value={v.tag}>{v.name} (Tag {v.tag})</option>)}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">ISO Image (optional)</label>
            <select value={form.iso} onChange={e => setForm(f => ({ ...f, iso: e.target.value }))} className={inputCls}>
              <option value="">None</option>
              {isos.map(i => <option key={i.volid} value={i.volid}>{i.volid.split('/').pop()}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">OS Type</label>
            <select value={form.ostype} onChange={e => setForm(f => ({ ...f, ostype: e.target.value }))} className={inputCls}>
              <option value="l26">Linux 2.6+</option>
              <option value="l24">Linux 2.4</option>
              <option value="win11">Windows 11/2022</option>
              <option value="win10">Windows 10/2016/2019</option>
              <option value="win8">Windows 8/2012</option>
              <option value="win7">Windows 7/2008</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <details className="group">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">Advanced options</summary>
          <div className="grid grid-cols-2 gap-4 mt-3 pt-3 border-t border-gray-800">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">BIOS</label>
              <select value={form.bios} onChange={e => setForm(f => ({ ...f, bios: e.target.value }))} className={inputCls}>
                <option value="seabios">SeaBIOS (Legacy)</option>
                <option value="ovmf">OVMF (UEFI)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">SCSI Controller</label>
              <select value={form.scsihw} onChange={e => setForm(f => ({ ...f, scsihw: e.target.value }))} className={inputCls}>
                <option value="virtio-scsi-single">VirtIO SCSI Single</option>
                <option value="virtio-scsi-pci">VirtIO SCSI</option>
                <option value="lsi">LSI 53C895A</option>
                <option value="megasas">MegaRAID SAS</option>
              </select>
            </div>
          </div>
        </details>

        {user?.isAdmin && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Assign to User</label>
            <select value={form.assignTo} onChange={e => setForm(f => ({ ...f, assignTo: e.target.value }))} className={inputCls}>
              <option value="">No assignment</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.username}{u.is_admin ? ' (admin)' : ''}</option>)}
            </select>
            <p className="text-xs text-gray-600 mt-1">Admins can see all VMs without an assignment.</p>
          </div>
        )}

        <div>
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">Description (optional)</label>
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className={`${inputCls} h-16 resize-none`} placeholder="What's this VM for?" />
        </div>

        {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}

        <button type="submit" disabled={saving || !form.node || !form.name} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-3 text-sm font-semibold transition-all shadow-lg shadow-blue-600/20">
          {saving ? 'Creating VM...' : 'Create VM'}
        </button>
      </form>
    </div>
  );
}

// ── Recent provisioning jobs ────────────────────────────────────────────────

function RecentProvisions() {
  const [jobs, setJobs] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/provision/status').then(r => setJobs(r.data)).catch(() => {});
    const interval = setInterval(() => {
      api.get('/provision/status').then(r => setJobs(r.data)).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  if (jobs.length === 0) return null;

  const statusColors = {
    cloning: 'bg-yellow-500/10 text-yellow-400 ring-yellow-500/20',
    creating: 'bg-yellow-500/10 text-yellow-400 ring-yellow-500/20',
    configuring: 'bg-blue-500/10 text-blue-400 ring-blue-500/20',
    ready: 'bg-green-500/10 text-green-400 ring-green-500/20',
    warning: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
    error: 'bg-red-500/10 text-red-400 ring-red-500/20',
    timeout: 'bg-red-500/10 text-red-400 ring-red-500/20',
  };

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Recent Provisions</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">VMID</th>
              <th className="text-left px-4 py-3">Template</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(j => (
              <tr
                key={j.id}
                className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 cursor-pointer transition-colors"
                onClick={() => ['ready', 'warning'].includes(j.status) && navigate(`/vm/${routeNode(j)}/${j.vmid}`)}
              >
                <td className="px-4 py-3">
                  <p className="text-white font-medium">{j.name}</p>
                  {j.status_detail && (
                    <p className={`text-xs mt-1 ${j.status === 'warning' ? 'text-amber-400' : 'text-gray-500'}`}>
                      {j.status_detail}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-400 font-mono">{j.vmid}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{j.template_name || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ring-1 ${statusColors[j.status] || statusColors.error}`}>
                    {j.status === 'cloning' || j.status === 'creating' || j.status === 'configuring' ? (
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        {j.status}
                      </span>
                    ) : j.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{new Date(j.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
