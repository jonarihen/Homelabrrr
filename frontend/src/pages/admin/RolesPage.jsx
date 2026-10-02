import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { defaultCloneName } from '../../utils/roleClone.js';
import { useAuth } from '../../contexts/AuthContext.jsx';

// Grouped presentation of the permission keys the backend exposes
const PERM_GROUPS = [
  {
    label: 'VM Access',
    perms: [
      { key: 'see_all_vms',    label: 'View all VMs (read-only)',  desc: 'See every VM on Proxmox without individual assignments — status, config, graphs and backup listings only. Grants no power, console or edit rights.' },
      { key: 'can_operate_all_vms', label: 'Operate all VMs', desc: 'Full operator control of every VM: VNC console, SSH and SFTP shell, power on/off/reboot, snapshots, backups, VLAN and hardware changes. Console + SSH on the whole fleet is effectively root on the fleet.', danger: true },
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
  const [cloneSource, setCloneSource] = useState(null);
  const [holdersRole, setHoldersRole] = useState(null);
  const [deleteRole, setDeleteRole] = useState(null);
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
                  <td className="px-4 py-3">
                    {role.userCount > 0 ? (
                      <button
                        onClick={() => setHoldersRole(role)}
                        className="text-gray-300 hover:text-blue-300 underline decoration-dotted decoration-gray-600 underline-offset-4 transition-colors"
                        title={`Show the ${role.userCount === 1 ? 'user' : 'users'} holding this role`}
                      >
                        {role.userCount}
                      </button>
                    ) : (
                      <span className="text-gray-600">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin ? (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setManageRole(role)}
                          className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                        >
                          Manage
                        </button>
                        <button
                          onClick={() => setCloneSource(role)}
                          className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                        >
                          Clone
                        </button>
                        {!role.builtIn && (
                          <button
                            onClick={() => setDeleteRole(role)}
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
      {cloneSource && (
        <RoleModal
          source={cloneSource}
          existingNames={roles.map(r => r.name)}
          onClose={() => setCloneSource(null)}
          onSaved={load}
        />
      )}
      {holdersRole && (
        <RoleHoldersModal
          role={holdersRole}
          onClose={() => setHoldersRole(null)}
        />
      )}
      {deleteRole && (
        <DeleteRoleModal
          role={deleteRole}
          roles={roles}
          onClose={() => setDeleteRole(null)}
          onDeleted={load}
        />
      )}
    </div>
  );
}

// The users holding a role. Each name links to the Users page, which opens that
// user's manage dialog from the ?user= parameter.
function RoleHoldersModal({ role, onClose }) {
  const [holders, setHolders] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/admin/roles/${role.id}/users`)
      .then(r => setHolders(r.data.users || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to load role holders'));
  }, [role.id]);

  return (
    <Modal title={`Holders — ${role.name}`} onClose={onClose} size="sm">
      <div className="p-5 space-y-3">
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        {holders === null && !error && <p className="text-xs text-gray-500">Loading…</p>}
        {holders?.length === 0 && <p className="text-xs text-gray-500">No users hold this role.</p>}
        {holders?.map(u => (
          <Link
            key={u.id}
            to={`/admin/users?user=${u.id}`}
            onClick={onClose}
            className="flex items-center justify-between bg-gray-800 hover:bg-gray-800/70 rounded-lg px-4 py-2.5 transition-colors"
          >
            <span className="text-sm text-white">{u.username}</span>
            <span className="flex items-center gap-2">
              {u.is_admin && <span className="text-[10px] uppercase tracking-wider text-amber-400">admin</span>}
              <span className="text-xs text-blue-400">Manage →</span>
            </span>
          </Link>
        ))}
      </div>
    </Modal>
  );
}

// Deleting a role is destructive for its holders, so say how many there are and
// offer to move them onto another role instead of dropping them to their
// per-user permissions.
function DeleteRoleModal({ role, roles, onClose, onDeleted }) {
  const [reassignTo, setReassignTo] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const holderCount = role.userCount;

  const submit = async (e) => {
    e.preventDefault();
    setDeleting(true);
    setError('');
    try {
      const query = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
      await api.delete(`/admin/roles/${role.id}${query}`);
      onDeleted();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete role');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal title={`Delete Role — ${role.name}`} onClose={onClose} size="sm">
      <form onSubmit={submit} className="p-5 space-y-4">
        <p className="text-sm text-gray-300">
          {holderCount === 0
            ? 'No users hold this role.'
            : `${holderCount} ${holderCount === 1 ? 'user holds' : 'users hold'} this role.`}
          {holderCount > 0 && ' Choose what happens to them.'}
        </p>

        {holderCount > 0 && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Move holders to</label>
            <select
              value={reassignTo}
              onChange={e => setReassignTo(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
            >
              <option value="">No role — fall back to per-user permissions</option>
              {roles.filter(r => r.id !== role.id).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1.5">
              {reassignTo
                ? 'Holders take the new role’s permissions and quotas immediately.'
                : 'Holders keep only the permissions set directly on their account.'}
            </p>
          </div>
        )}

        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg py-2.5 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={deleting}
            className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
          >
            {deleting ? 'Deleting…' : 'Delete Role'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Create, edit and clone share one modal: `role` present = edit mode, `source`
// present = clone mode (the form starts as a copy of `source` and POSTs to the
// clone route, so nothing is written until it's submitted).
function RoleModal({ role, source, existingNames = [], onClose, onSaved }) {
  const editing = !!role;
  const cloning = !!source;
  const template = role || source;
  const [name, setName] = useState(
    cloning ? defaultCloneName(source.name, existingNames) : (role?.name || ''),
  );
  const [description, setDescription] = useState(template?.description || '');
  const [perms, setPerms] = useState(() => new Set(template?.permissions || []));
  const [quotas, setQuotas] = useState({
    maxCores: template?.max_cores ?? '',
    maxMemoryGb: template?.max_memory_gb ?? '',
    maxStorageGb: template?.max_storage_gb ?? '',
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
      else if (cloning) await api.post(`/admin/roles/${source.id}/clone`, payload);
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
    <Modal
      title={editing ? `Role — ${role.name}` : cloning ? `Clone Role — ${source.name}` : 'Create Role'}
      onClose={onClose}
      size="lg"
    >
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
              onFocus={cloning ? (e => e.target.select()) : undefined}
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
        {cloning && (
          <p className="text-xs text-gray-500 bg-gray-800/60 rounded-lg px-3 py-2">
            Prefilled from <span className="text-gray-300">{source.name}</span>
            {source.builtIn && ' (built-in)'} — the clone is an ordinary role with an editable name
            and description, and starts with no holders. Nothing is created until you save.
          </p>
        )}

        {PERM_GROUPS.map(group => (
          <div key={group.label} className="space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">{group.label}</p>
            {group.perms.map(p => (
              <label
                key={p.key}
                className={`flex items-center justify-between rounded-lg px-4 py-2.5 cursor-pointer transition-colors ${
                  p.danger && perms.has(p.key)
                    ? 'bg-amber-900/20 border border-amber-800/40 hover:bg-amber-900/25'
                    : 'bg-gray-800 hover:bg-gray-800/80'
                }`}
              >
                <div>
                  <p className="text-sm text-white">
                    {p.label}
                    {p.danger && <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-400">high blast radius</span>}
                  </p>
                  <p className={`text-xs ${p.danger && perms.has(p.key) ? 'text-amber-300/80' : 'text-gray-500'}`}>{p.desc}</p>
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
          {saving ? 'Saving...' : editing ? 'Save Role' : cloning ? 'Create Clone' : 'Create Role'}
        </button>
      </form>
    </Modal>
  );
}
