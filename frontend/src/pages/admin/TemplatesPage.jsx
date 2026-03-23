import { useState, useEffect } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';

export default function TemplatesPage() {
  useDocumentTitle('Templates');
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTemplate, setEditTemplate] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const r = await api.get('/provision/admin/templates');
      setTemplates(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const deleteTemplate = async (id, name) => {
    if (!confirm(`Delete template "${name}"? This does not delete the actual VM.`)) return;
    try {
      await api.delete(`/provision/admin/templates/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="p-6 lg:p-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">VM Templates</h1>
          <p className="text-sm text-gray-500 mt-1">Register Proxmox VM templates that users can clone</p>
        </div>
        <button
          onClick={() => { setEditTemplate(null); setShowForm(true); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Template
        </button>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 text-red-400 text-sm mb-6">{error}</div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2].map(i => <div key={i} className="h-28 bg-gray-900 rounded-2xl animate-pulse" />)}
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-gray-800/50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <p className="text-gray-400 font-medium">No templates registered</p>
          <p className="text-sm text-gray-600 mt-1">Add a Proxmox VM template to allow users to clone VMs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 relative overflow-hidden">
              <div className={`absolute inset-x-0 top-0 h-0.5 ${t.enabled ? 'bg-gradient-to-r from-green-500 via-blue-500 to-purple-500' : 'bg-gray-700'}`} />
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
                    <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-white font-semibold">{t.name}</h3>
                    <p className="text-xs text-gray-500 font-mono">VMID {t.vmid} / {t.node}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!t.enabled && (
                    <span className="text-xs px-2 py-0.5 bg-gray-800 text-gray-500 rounded-full ring-1 ring-gray-700">Disabled</span>
                  )}
                  {t.cloud_init ? (
                    <span className="text-xs px-2 py-0.5 bg-cyan-500/10 text-cyan-400 rounded-full ring-1 ring-cyan-500/20">Cloud-Init</span>
                  ) : null}
                </div>
              </div>

              {t.description && <p className="text-xs text-gray-500 mb-3">{t.description}</p>}

              <div className="flex items-center gap-4 text-xs text-gray-400 mb-4">
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25z" /></svg>
                  {t.default_cores} cores
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 3h12l3 6-3 6H6L3 9l3-6z" /></svg>
                  {t.default_memory >= 1024 ? `${(t.default_memory / 1024).toFixed(t.default_memory % 1024 === 0 ? 0 : 1)} GB` : `${t.default_memory} MB`} RAM
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375" /></svg>
                  {t.default_disk_gb} GB disk
                </span>
                <span className="text-gray-600">{t.default_storage}</span>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => { setEditTemplate(t); setShowForm(true); }}
                  className="text-xs text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded-lg border border-blue-500/20 hover:border-blue-500/40 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteTemplate(t.id, t.name)}
                  className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg border border-red-500/20 hover:border-red-500/40 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <TemplateFormModal
          template={editTemplate}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
        />
      )}
    </div>
  );
}

function TemplateFormModal({ template, onClose, onSaved }) {
  const isEdit = !!template;
  const [nodes, setNodes] = useState([]);
  const [storages, setStorages] = useState([]);
  const [pveVms, setPveVms] = useState([]);
  const [loadingPve, setLoadingPve] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [form, setForm] = useState({
    name: template?.name || '',
    description: template?.description || '',
    node: template?.node || '',
    vmid: template?.vmid || '',
    defaultCores: template?.default_cores || 2,
    defaultMemoryGb: template ? Math.round(template.default_memory / 1024 * 10) / 10 : 2,
    defaultDiskGb: template?.default_disk_gb || 20,
    defaultStorage: template?.default_storage || 'local-lvm',
    cloudInit: template?.cloud_init || false,
    enabled: template?.enabled !== 0,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/provision/nodes').then(r => setNodes(r.data)).catch(() => {});
  }, []);

  // Fetch storages whenever we have a node
  useEffect(() => {
    if (!form.node) return;
    api.get(`/provision/nodes/${form.node}/storages`)
      .then(r => setStorages(r.data))
      .catch(() => setStorages([]));
  }, [form.node]);

  // Fetch all qemu VMs on the selected node (templates + regular)
  useEffect(() => {
    if (!form.node || isEdit) return;
    setLoadingPve(true);
    setPveVms([]);
    api.get(`/provision/admin/pve-vms/${form.node}`)
      .then(r => setPveVms(r.data))
      .catch(() => setPveVms([]))
      .finally(() => setLoadingPve(false));
  }, [form.node, isEdit]);

  // When a source VM is selected, fetch its config and auto-populate defaults
  const selectSourceVm = async (vmid) => {
    if (!vmid) {
      setForm(f => ({ ...f, vmid: '' }));
      return;
    }
    const vm = pveVms.find(v => String(v.vmid) === String(vmid));
    setForm(f => ({ ...f, vmid }));
    setLoadingConfig(true);
    try {
      const r = await api.get(`/provision/admin/pve-vms/${form.node}/${vmid}/config`);
      const cfg = r.data;
      setForm(f => ({
        ...f,
        vmid,
        name: f.name || cfg.name || vm?.name || `Template ${vmid}`,
        description: f.description || cfg.description || '',
        defaultCores: cfg.cores || f.defaultCores,
        defaultMemoryGb: cfg.memoryMb ? Math.round(cfg.memoryMb / 1024 * 10) / 10 : f.defaultMemoryGb,
        defaultDiskGb: cfg.diskGb || f.defaultDiskGb,
        defaultStorage: cfg.storage || f.defaultStorage,
        cloudInit: !!cfg.cloudInit,
      }));
    } catch {
      // Couldn't fetch config — just set vmid and name
      setForm(f => ({
        ...f,
        vmid,
        name: f.name || vm?.name || `Template ${vmid}`,
      }));
    } finally {
      setLoadingConfig(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        defaultMemory: Math.round(parseFloat(form.defaultMemoryGb) * 1024),
      };
      delete payload.defaultMemoryGb;
      if (isEdit) {
        await api.put(`/provision/admin/templates/${template.id}`, payload);
      } else {
        await api.post('/provision/admin/templates', payload);
      }
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const uniqueNodes = [...new Set(nodes.map(n => n.node))];
  const templateVms = pveVms.filter(v => v.template);
  const regularVms = pveVms.filter(v => !v.template);

  return (
    <Modal title={isEdit ? 'Edit Template' : 'Add Template'} onClose={onClose} size="md">
      <form onSubmit={submit} className="p-5 space-y-4">
        {!isEdit && (
          <>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Node</label>
              <select
                value={form.node}
                onChange={e => { setForm(f => ({ ...f, node: e.target.value, vmid: '' })); setPveVms([]); }}
                className={inputCls}
                required
              >
                <option value="">Select node...</option>
                {uniqueNodes.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            {form.node && (
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Source VM</label>
                {loadingPve ? (
                  <div className="text-xs text-gray-500 py-2">Loading VMs from Proxmox...</div>
                ) : pveVms.length === 0 ? (
                  <div className="text-xs text-gray-500 py-2">No qemu VMs found on this node</div>
                ) : (
                  <>
                    <select
                      value={form.vmid}
                      onChange={e => selectSourceVm(e.target.value)}
                      className={inputCls}
                      required
                    >
                      <option value="">Select a VM...</option>
                      {templateVms.length > 0 && (
                        <optgroup label="Proxmox Templates">
                          {templateVms.map(v => (
                            <option key={v.vmid} value={v.vmid}>
                              {v.name || `VM ${v.vmid}`} (VMID {v.vmid})
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {regularVms.length > 0 && (
                        <optgroup label="Regular VMs">
                          {regularVms.map(v => (
                            <option key={v.vmid} value={v.vmid}>
                              {v.name || `VM ${v.vmid}`} (VMID {v.vmid}) {v.status !== 'running' ? `[${v.status}]` : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    {loadingConfig && <p className="text-xs text-blue-400 mt-1">Reading VM config...</p>}
                  </>
                )}
              </div>
            )}
          </>
        )}

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Template Name</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className={inputCls}
            placeholder="e.g. Ubuntu 22.04 Server"
            required
          />
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            className={`${inputCls} h-16 resize-none`}
            placeholder="Optional description for users"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Default Cores</label>
            <input type="number" min="1" value={form.defaultCores} onChange={e => setForm(f => ({ ...f, defaultCores: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Default RAM (GB)</label>
            <input type="number" min="0.5" step="0.5" value={form.defaultMemoryGb} onChange={e => setForm(f => ({ ...f, defaultMemoryGb: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Default Disk (GB)</label>
            <input type="number" min="1" value={form.defaultDiskGb} onChange={e => setForm(f => ({ ...f, defaultDiskGb: e.target.value }))} className={inputCls} />
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Default Storage</label>
          {storages.length > 0 ? (
            <select
              value={form.defaultStorage}
              onChange={e => setForm(f => ({ ...f, defaultStorage: e.target.value }))}
              className={inputCls}
            >
              {!storages.find(s => s.storage === form.defaultStorage) && form.defaultStorage && (
                <option value={form.defaultStorage}>{form.defaultStorage}</option>
              )}
              {storages.filter(s => s.content?.includes('images')).map(s => (
                <option key={s.storage} value={s.storage}>{s.storage} ({s.type})</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={form.defaultStorage}
              onChange={e => setForm(f => ({ ...f, defaultStorage: e.target.value }))}
              className={inputCls}
              placeholder="local-lvm"
            />
          )}
        </div>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input type="checkbox" checked={form.cloudInit} onChange={e => setForm(f => ({ ...f, cloudInit: e.target.checked }))} className="rounded bg-gray-800 border-gray-600" />
            Cloud-Init enabled
          </label>
          {isEdit && (
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded bg-gray-800 border-gray-600" />
              Enabled
            </label>
          )}
        </div>

        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5">{error}</p>}

        <button type="submit" disabled={saving} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors">
          {saving ? 'Saving...' : isEdit ? 'Update Template' : 'Add Template'}
        </button>
      </form>
    </Modal>
  );
}
