import { useState, useEffect } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { useAuth } from '../../contexts/AuthContext.jsx';

// Grouped presentation of the permission keys the backend exposes
const PERM_GROUPS = [
  {
    label: 'VM Access',
    perms: [
      { key: 'see_all_vms',    label: 'Access all VMs',  desc: 'See every VM on Proxmox without individual assignments' },
      { key: 'can_provision',  label: 'Provision VMs',   desc: 'Create VMs from templates and cloud images' },
      { key: 'can_create_vms', label: 'Create VMs',      desc: 'Build VMs from scratch / from an available ISO' },
      { key: 'can_edit_vm_hardware', label: 'Edit VM Hardware', desc: 'Change CPU, memory, and disk size on assigned VMs' },
    ],
  },
  {
    label: 'Admin Features',
    perms: [
      { key: 'can_manage_hosts',       label: 'Manage PVE Hosts',   desc: 'Add, edit, and remove Proxmox hypervisor connections' },
      { key: 'can_manage_firewalls',   label: 'Manage Firewalls',   desc: 'Configure FortiGate firewalls and switch discovery' },
      { key: 'can_manage_port_forwards', label: 'Manage Port Forwards', desc: 'Create and remove scoped WAN port forwards' },
      { key: 'can_manage_vlans',       label: 'Manage VLANs',       desc: 'Create, edit, delete VLANs and sync to firewalls' },
      { key: 'can_manage_policies',    label: 'Manage Policies',    desc: 'Create and remove firewall policies between VLANs' },
      { key: 'can_manage_templates',   label: 'Manage Templates',   desc: 'Register and configure VM provisioning templates' },
      { key: 'can_manage_users',       label: 'Manage Users',       desc: 'Create, edit, delete user accounts and permissions' },
      { key: 'can_manage_assignments', label: 'Manage Assignments', desc: 'Assign VMs and VLANs to users' },
      { key: 'can_view_audit_log',     label: 'View Audit Log',     desc: 'Read the system audit log' },
      { key: 'can_manage_websites',    label: 'Manage Websites',    desc: 'Register the Caddy reverse proxy, see all published sites, and assign site ownership' },
      { key: 'can_manage_public_ips',  label: 'Manage Public IPs',  desc: 'Register public IP pools, reserve addresses, and assign dedicated public IPs to users' },
    ],
  },
];

export default function RolesPage() {
  useDocumentTitle('Roles');
  const { user: currentUser } = useAuth();
  const isAdmin = !!currentUser?.isAdmin;
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageRole, setManageRole] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const r = await api.get('/admin/roles');
      setRoles(r.data.roles || []);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const deleteRole = async (role) => {
    if (!confirm(`Delete the role "${role.name}"? Users holding it fall back to their per-user permissions.`)) return;
    try {
      await api.delete(`/admin/roles/${role.id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete role');
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="aaris-display text-lg text-gray-100">Roles</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Named permission sets — assign a role to a user on the Users page. Editing a role updates everyone who holds it.
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            + New Role
          </button>
        )}
      </div>

      {error && <p className="text-red-400 text-sm mb-4 bg-red-900/20 rounded p-3">{error}</p>}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map(i => <div key={i} className="h-16 bg-gray-900 rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Permissions</th>
                <th className="text-left px-4 py-3">Users</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {roles.map(role => (
                <tr key={role.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">{role.name}</span>
                      {role.builtIn && <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">Built-in</span>}
                    </div>
                    {role.description && <p className="text-xs text-gray-500 mt-0.5">{role.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    {role.permissions.length > 0
                      ? <span className="text-xs text-purple-400">{role.permissions.length} granted</span>
                      : <span className="text-xs text-gray-600">None</span>}
                    {(role.max_cores != null || role.max_memory_gb != null || role.max_storage_gb != null) && (
                      <p className="text-xs text-gray-500 font-mono mt-0.5">
                        {[
                          role.max_cores != null ? `${role.max_cores}c` : null,
                          role.max_memory_gb != null ? `${role.max_memory_gb}G mem` : null,
                          role.max_storage_gb != null ? `${role.max_storage_gb}G disk` : null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{role.userCount}</td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin ? (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setManageRole(role)}
                          className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                        >
                          Manage
                        </button>
                        {!role.builtIn && (
                          <button
                            onClick={() => deleteRole(role)}
                            className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-600">Admin only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <RoleModal
          onClose={() => setCreateOpen(false)}
          onSaved={load}
        />
      )}
      {manageRole && (
        <RoleModal
          role={manageRole}
          onClose={() => setManageRole(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

// Create + edit share one modal; `role` present = edit mode
function RoleModal({ role, onClose, onSaved }) {
  const editing = !!role;
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [perms, setPerms] = useState(() => new Set(role?.permissions || []));
  const [quotas, setQuotas] = useState({
    maxCores: role?.max_cores ?? '',
    maxMemoryGb: role?.max_memory_gb ?? '',
    maxStorageGb: role?.max_storage_gb ?? '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = (key) => {
    setPerms(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { name, description, permissions: [...perms], ...quotas };
      if (editing) await api.put(`/admin/roles/${role.id}`, payload);
      else await api.post('/admin/roles', payload);
      onSaved();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save role');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';

  return (
    <Modal title={editing ? `Role — ${role.name}` : 'Create Role'} onClose={onClose} size="lg">
      <form onSubmit={submit} className="p-5 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Name</label>
            <input
              type="text"
              required
              value={name}
              disabled={editing && role.builtIn}
              onChange={e => setName(e.target.value)}
              className={`${inputCls} disabled:opacity-50`}
              autoFocus={!editing}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Description</label>
            <input
              type="text"
              value={description}
              disabled={editing && role.builtIn}
              onChange={e => setDescription(e.target.value)}
              className={`${inputCls} disabled:opacity-50`}
            />
          </div>
        </div>
        {editing && role.builtIn && (
          <p className="text-xs text-gray-500 bg-gray-800/60 rounded-lg px-3 py-2">
            Built-in role — name and description are fixed, but you can adjust its permissions.
          </p>
        )}

        {PERM_GROUPS.map(group => (
          <div key={group.label} className="space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">{group.label}</p>
            {group.perms.map(p => (
              <label
                key={p.key}
                className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2.5 cursor-pointer hover:bg-gray-800/80 transition-colors"
              >
                <div>
                  <p className="text-sm text-white">{p.label}</p>
                  <p className="text-xs text-gray-500">{p.desc}</p>
                </div>
                <input
                  type="checkbox"
                  checked={perms.has(p.key)}
                  onChange={() => toggle(p.key)}
                  className="accent-blue-500 w-4 h-4 shrink-0 ml-3"
                />
              </label>
            ))}
          </div>
        ))}

        <div className="space-y-1">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Resource Quotas</p>
          <p className="text-xs text-gray-500 mb-2">
            Default limits for every user holding this role. Empty = unlimited. A per-user quota set on the Users page overrides the role's value for that metric.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { key: 'maxCores', label: 'Max CPU cores' },
              { key: 'maxMemoryGb', label: 'Max memory (GB)' },
              { key: 'maxStorageGb', label: 'Max storage (GB)' },
            ].map(q => (
              <div key={q.key}>
                <label className="block text-xs text-gray-400 mb-1.5">{q.label}</label>
                <input
                  type="number"
                  min="0"
                  placeholder="Unlimited"
                  value={quotas[q.key]}
                  onChange={e => setQuotas(f => ({ ...f, [q.key]: e.target.value }))}
                  className={inputCls}
                />
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
        >
          {saving ? 'Saving...' : editing ? 'Save Role' : 'Create Role'}
        </button>
      </form>
    </Modal>
  );
}
