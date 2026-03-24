import { useState, useEffect } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { displayNode, routeNode, vmIdentityKey } from '../../utils/nodeRef.js';

export default function UsersPage() {
  useDocumentTitle('Users');
  const { user: currentUser } = useAuth();
  const canGrantPrivileges = !!currentUser?.isAdmin;
  const [users, setUsers]           = useState([]);
  const [allVMs, setAllVMs]         = useState([]);
  const [allVLANs, setAllVLANs]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageUser, setManageUser] = useState(null);
  const [error, setError]           = useState('');

  const load = async () => {
    try {
      const [u, v, vl] = await Promise.all([
        api.get('/admin/users'),
        api.get('/admin/vms'),
        api.get('/admin/vlans'),
      ]);
      setUsers(u.data);
      setAllVMs(v.data);
      setAllVLANs(vl.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const deleteUser = async (id) => {
    if (!confirm('Delete this user? This will also remove their VM and VLAN assignments.')) return;
    try {
      await api.delete(`/admin/users/${id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  const unlockUser = async (id) => {
    try {
      await api.post(`/admin/users/${id}/unlock`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to unlock');
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Users</h1>
          <p className="text-sm text-gray-500 mt-0.5">{users.length} accounts</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New User
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-4 bg-red-900/20 rounded p-3">{error}</p>}

      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-16 bg-gray-900 rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Username</th>
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Permissions</th>
                <th className="text-left px-4 py-3">VMs</th>
                <th className="text-left px-4 py-3">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 text-white font-medium">{u.username}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {u.is_admin
                        ? <span className="text-xs bg-blue-900 text-blue-300 px-2 py-0.5 rounded">Admin</span>
                        : <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">User</span>
                      }
                      {u.twoFactorEnabled
                        ? <span className="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded">2FA</span>
                        : u.require2fa && <span className="text-xs bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded">No 2FA</span>
                      }
                      {u.locked && <span className="text-xs bg-red-900 text-red-300 px-2 py-0.5 rounded">Locked</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.is_admin
                      ? <span className="text-xs text-blue-400">Full access</span>
                      : (() => {
                        const count = PERM_DEFS.filter(p => u[p.key]).length + (u.can_provision ? 1 : 0);
                        return count > 0
                          ? <span className="text-xs text-purple-400">{count} granted</span>
                          : <span className="text-xs text-gray-600">None</span>;
                      })()
                    }
                  </td>
                  <td className="px-4 py-3 text-gray-400">{u.see_all_vms ? <span className="text-xs text-blue-400">All</span> : u.vm_count}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {u.locked && (canGrantPrivileges || !u.is_admin) && (
                        <button
                          onClick={() => unlockUser(u.id)}
                          className="text-xs text-yellow-400 hover:text-yellow-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                        >
                          Unlock
                        </button>
                      )}
                      {(canGrantPrivileges || !u.is_admin) ? (
                        <>
                          <button
                            onClick={() => setManageUser(u)}
                            className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                          >
                            Manage
                          </button>
                          <button
                            onClick={() => deleteUser(u.id)}
                            className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-gray-600">Admin only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreateUserModal
          canCreateAdmin={canGrantPrivileges}
          onClose={() => setCreateOpen(false)}
          onCreated={load}
        />
      )}

      {manageUser && (
        <ManageUserModal
          currentUser={currentUser}
          user={manageUser}
          allVMs={allVMs}
          allVLANs={allVLANs}
          onClose={() => { setManageUser(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Create User Modal ────────────────────────────────────────────────────────

function CreateUserModal({ canCreateAdmin, onClose, onCreated }) {
  const [form, setForm]   = useState({ username: '', password: '', isAdmin: false });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/admin/users', form);
      onCreated();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create User" onClose={onClose} size="sm">
      <form onSubmit={submit} className="p-5 space-y-4">
        <Field label="Username">
          <input
            type="text"
            required
            value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            className={inputCls}
            autoFocus
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            className={inputCls}
          />
        </Field>
        {canCreateAdmin && (
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isAdmin}
              onChange={e => setForm(f => ({ ...f, isAdmin: e.target.checked }))}
              className="accent-blue-500"
            />
            <span className="text-sm text-gray-300">Admin account</span>
          </label>
        )}
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <button type="submit" disabled={saving} className={btnCls}>
          {saving ? 'Creating...' : 'Create User'}
        </button>
      </form>
    </Modal>
  );
}

// ─── Manage User Modal ────────────────────────────────────────────────────────

const PERM_DEFS = [
  { key: 'can_manage_hosts',       label: 'Manage PVE Hosts',   desc: 'Add, edit, and remove Proxmox hypervisor connections' },
  { key: 'can_manage_firewalls',   label: 'Manage Firewalls',   desc: 'Configure FortiGate firewalls and switch discovery' },
  { key: 'can_manage_port_forwards', label: 'Manage Port Forwards', desc: 'Create and remove scoped WAN port forwards for assigned VMs and VLANs' },
  { key: 'can_manage_vlans',       label: 'Manage VLANs',       desc: 'Create, edit, delete VLANs and sync to firewalls' },
  { key: 'can_manage_policies',    label: 'Manage Policies',    desc: 'Create and remove firewall policies between assigned VLANs' },
  { key: 'can_manage_templates',   label: 'Manage Templates',   desc: 'Register and configure VM provisioning templates' },
  { key: 'can_manage_users',       label: 'Manage Users',       desc: 'Create, edit, delete user accounts and permissions' },
  { key: 'can_manage_assignments', label: 'Manage Assignments', desc: 'Assign VMs and VLANs to users' },
  { key: 'can_view_audit_log',     label: 'View Audit Log',     desc: 'Read the system audit log' },
];

function ManageUserModal({ currentUser, user, allVMs, allVLANs, onClose }) {
  const canGrantPrivileges = !!currentUser?.isAdmin;
  const [tab, setTab]           = useState(() => canGrantPrivileges ? 'permissions' : 'vms');
  const [userVMs, setUserVMs]   = useState([]);
  const [userVLANs, setUserVLANs] = useState([]);
  const [seeAllVMs, setSeeAllVMs] = useState(!!user.see_all_vms);
  const [canProvision, setCanProvision] = useState(!!user.canProvision);
  const [require2fa, setRequire2fa] = useState(!!user.require2fa);
  const [perms, setPerms]       = useState(() => {
    const p = {};
    PERM_DEFS.forEach(d => { p[d.key] = !!user[d.key]; });
    return p;
  });
  const [newPw, setNewPw]       = useState('');
  const [pwMsg, setPwMsg]       = useState('');
  const [newUsername, setNewUsername] = useState(user.username);
  const [usernameMsg, setUsernameMsg] = useState('');
  const [twoFaMsg, setTwoFaMsg] = useState('');
  const [error, setError]       = useState('');

  const loadUserData = async () => {
    const [vms, vlans] = await Promise.all([
      api.get(`/admin/users/${user.id}/vms`),
      api.get(`/admin/users/${user.id}/vlans`),
    ]);
    setUserVMs(vms.data);
    setUserVLANs(vlans.data);
  };

  useEffect(() => { loadUserData(); }, [user.id]);

  const toggleSeeAllVMs = async (enabled) => {
    try {
      await api.put(`/admin/users/${user.id}/see-all-vms`, { enabled });
      setSeeAllVMs(enabled);
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const toggleCanProvision = async (enabled) => {
    try {
      await api.put(`/admin/users/${user.id}/can-provision`, { enabled });
      setCanProvision(enabled);
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const togglePermission = async (permission, enabled) => {
    try {
      await api.put(`/admin/users/${user.id}/permission`, { permission, enabled });
      setPerms(prev => ({ ...prev, [permission]: enabled }));
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const toggleRequire2fa = async (enabled) => {
    try {
      await api.put(`/admin/users/${user.id}/require-2fa`, { enabled });
      setRequire2fa(enabled);
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const assignVM = async (vm) => {
    try {
      await api.post('/admin/assignments', { userId: user.id, node: routeNode(vm), vmid: vm.vmid });
      loadUserData();
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const unassignVM = async (assignment) => {
    try {
      await api.delete(`/admin/assignments/${assignment.id}`);
      loadUserData();
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const assignVLAN = async (vlan) => {
    try {
      await api.post(`/admin/users/${user.id}/vlans`, { vlanId: vlan.id });
      loadUserData();
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const unassignVLAN = async (vlan) => {
    try {
      await api.delete(`/admin/users/${user.id}/vlans/${vlan.id}`);
      loadUserData();
    } catch (e) { setError(e.response?.data?.error || 'Failed'); }
  };

  const resetTwoFactor = async () => {
    try {
      await api.post(`/admin/users/${user.id}/reset-2fa`);
      setTwoFaMsg('2FA has been disabled for this user.');
    } catch (e) { setTwoFaMsg('Failed: ' + (e.response?.data?.error || e.message)); }
  };

  const changeUsername = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/admin/users/${user.id}/username`, { username: newUsername });
      setUsernameMsg('Username changed');
    } catch (e) { setUsernameMsg('Failed: ' + (e.response?.data?.error || e.message)); }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/admin/users/${user.id}/password`, { password: newPw });
      setPwMsg('Password changed');
      setNewPw('');
    } catch (e) { setPwMsg('Failed: ' + (e.response?.data?.error || e.message)); }
  };

  const assignedVMIds = new Set(userVMs.map(vmIdentityKey));
  const assignedVLANIds = new Set(userVLANs.map(v => v.id));

  const unassignedVMs = allVMs.filter(v => !assignedVMIds.has(vmIdentityKey(v)));
  const unassignedVLANs = allVLANs.filter(v => !assignedVLANIds.has(v.id));

  return (
    <Modal title={`Manage — ${user.username}`} onClose={onClose} size="lg">
      <div className="flex border-b border-gray-700 overflow-x-auto">
        {[
          ...(canGrantPrivileges ? [{ id: 'permissions', label: 'Permissions' }] : []),
          { id: 'vms', label: 'VM Assignments' },
          { id: 'vlans', label: 'VLAN Access' },
          { id: 'account', label: 'Account' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setError(''); }}
            className={`px-5 py-3 text-sm whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'text-white border-b-2 border-blue-500'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-5">
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2 mb-4">{error}</p>}

        {canGrantPrivileges && tab === 'permissions' && (
          <div className="space-y-4">
            {user.is_admin ? (
              <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg px-4 py-3">
                <p className="text-sm text-blue-300 font-medium">This user is an admin</p>
                <p className="text-xs text-blue-400/70 mt-0.5">Admins bypass all permission checks and have full access to everything.</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500">Control which admin features this user can access. Admins always have full access.</p>

                <div className="space-y-1">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">VM Access</p>
                  <PermToggle
                    label="Access all VMs"
                    desc="Grant access to every VM on Proxmox without individual assignments"
                    checked={seeAllVMs}
                    onChange={toggleSeeAllVMs}
                  />
                  <PermToggle
                    label="Provision VMs"
                    desc="Allow this user to create VMs from templates"
                    checked={canProvision}
                    onChange={toggleCanProvision}
                  />
                </div>

                <div className="space-y-1 pt-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Admin Features</p>
                  {PERM_DEFS.map(pDef => (
                    <PermToggle
                      key={pDef.key}
                      label={pDef.label}
                      desc={pDef.desc}
                      checked={perms[pDef.key]}
                      onChange={(enabled) => togglePermission(pDef.key, enabled)}
                    />
                  ))}
                </div>

                <div className="space-y-1 pt-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Security</p>
                  <PermToggle
                    label="Enforce 2FA"
                    desc="Force this user to enable two-factor authentication"
                    checked={require2fa}
                    onChange={toggleRequire2fa}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'vms' && (
          <div className="space-y-4">
            {seeAllVMs && (
              <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg px-4 py-2.5">
                <p className="text-xs text-blue-300">This user has "Access all VMs" enabled (change in Permissions tab)</p>
              </div>
            )}
            {!seeAllVMs && (
              <>
                <Section title="Assigned VMs">
                  {userVMs.length === 0
                    ? <Empty text="No VMs assigned" />
                    : userVMs.map(a => {
                      const vm = allVMs.find(v => vmIdentityKey(v) === vmIdentityKey(a));
                      return (
                        <Row
                          key={a.id}
                          label={vm?.name || `VM ${a.vmid}`}
                          sub={`${displayNode(a.node)} · VMID ${a.vmid}`}
                          badge={vm?.status}
                          action={<DangerBtn onClick={() => unassignVM(a)}>Remove</DangerBtn>}
                        />
                      );
                    })
                  }
                </Section>
                <Section title="Available VMs">
                  {unassignedVMs.length === 0
                    ? <Empty text="All VMs are assigned" />
                    : unassignedVMs.map(vm => (
                      <Row
                        key={vmIdentityKey(vm)}
                        label={vm.name || `VM ${vm.vmid}`}
                        sub={`${displayNode(vm.node)} · VMID ${vm.vmid}`}
                        badge={vm.status}
                        action={<BlueBtn onClick={() => assignVM(vm)}>Assign</BlueBtn>}
                      />
                    ))
                  }
                </Section>
              </>
            )}
          </div>
        )}

        {tab === 'vlans' && (
          <div className="space-y-4">
            <Section title="Assigned VLANs">
              {userVLANs.length === 0
                ? <Empty text="No VLANs assigned" />
                : userVLANs.map(v => (
                  <Row
                    key={v.id}
                    label={v.name}
                    sub={`Tag ${v.tag}${v.description ? ' · ' + v.description : ''}`}
                    action={<DangerBtn onClick={() => unassignVLAN(v)}>Remove</DangerBtn>}
                  />
                ))
              }
            </Section>
            <Section title="Available VLANs">
              {unassignedVLANs.length === 0
                ? <Empty text="All VLANs are assigned" />
                : unassignedVLANs.map(v => (
                  <Row
                    key={v.id}
                    label={v.name}
                    sub={`Tag ${v.tag}${v.description ? ' · ' + v.description : ''}`}
                    action={<BlueBtn onClick={() => assignVLAN(v)}>Assign</BlueBtn>}
                  />
                ))
              }
            </Section>
          </div>
        )}

        {tab === 'account' && (
          <div className="space-y-6 max-w-sm">
            <form onSubmit={changeUsername} className="space-y-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Change Username</p>
              <Field label="Username">
                <input
                  type="text"
                  required
                  value={newUsername}
                  onChange={e => { setNewUsername(e.target.value); setUsernameMsg(''); }}
                  className={inputCls}
                  autoFocus
                />
              </Field>
              {usernameMsg && <p className={`text-xs ${usernameMsg.startsWith('Failed') ? 'text-red-400' : 'text-green-400'}`}>{usernameMsg}</p>}
              <button type="submit" className={btnCls}>Change Username</button>
            </form>

            <div className="border-t border-gray-700 pt-6">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Two-Factor Authentication</p>
              {canGrantPrivileges && user.twoFactorEnabled ? (
                <div className="space-y-2">
                  <p className="text-xs text-gray-400">This user has 2FA enabled. You can disable it on their behalf if they have lost access to their authenticator.</p>
                  {twoFaMsg && <p className={`text-xs ${twoFaMsg.startsWith('Failed') ? 'text-red-400' : 'text-green-400'}`}>{twoFaMsg}</p>}
                  <button
                    type="button"
                    onClick={resetTwoFactor}
                    className="text-sm text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 px-4 py-2 rounded-lg transition-colors"
                  >
                    Disable 2FA for this user
                  </button>
                </div>
              ) : canGrantPrivileges ? (
                <p className="text-xs text-gray-600 italic">2FA is not enabled for this user.</p>
              ) : (
                <p className="text-xs text-gray-600 italic">Only admins can reset another user's 2FA.</p>
              )}
            </div>

            <div className="border-t border-gray-700 pt-6">
              <form onSubmit={changePassword} className="space-y-4">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Change Password</p>
                <Field label="New Password">
                  <input
                    type="password"
                    required
                    value={newPw}
                    onChange={e => { setNewPw(e.target.value); setPwMsg(''); }}
                    className={inputCls}
                  />
                </Field>
                {pwMsg && <p className={`text-xs ${pwMsg.startsWith('Failed') ? 'text-red-400' : 'text-green-400'}`}>{pwMsg}</p>}
                <button type="submit" className={btnCls}>Change Password</button>
              </form>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';
const btnCls   = 'w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors';

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, sub, badge, action }) {
  const badgeColors = {
    running: 'bg-green-900 text-green-300',
    stopped: 'bg-red-900 text-red-300',
  };
  return (
    <div className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5">
      <div>
        <p className="text-sm text-white">{label}</p>
        <p className="text-xs text-gray-500">{sub}</p>
      </div>
      <div className="flex items-center gap-2">
        {badge && <span className={`text-xs px-2 py-0.5 rounded ${badgeColors[badge] || 'bg-gray-700 text-gray-400'}`}>{badge}</span>}
        {action}
      </div>
    </div>
  );
}

function Empty({ text }) {
  return <p className="text-xs text-gray-600 italic py-2 px-3">{text}</p>;
}

function BlueBtn({ children, onClick }) {
  return (
    <button onClick={onClick} className="text-xs px-3 py-1 bg-blue-700 hover:bg-blue-600 text-white rounded transition-colors">
      {children}
    </button>
  );
}

function DangerBtn({ children, onClick }) {
  return (
    <button onClick={onClick} className="text-xs px-3 py-1 bg-red-800 hover:bg-red-700 text-white rounded transition-colors">
      {children}
    </button>
  );
}

function PermToggle({ label, desc, checked, onChange }) {
  return (
    <label className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2.5 cursor-pointer hover:bg-gray-800/80 transition-colors">
      <div>
        <p className="text-sm text-white">{label}</p>
        {desc && <p className="text-xs text-gray-500">{desc}</p>}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="accent-blue-500 w-4 h-4 shrink-0 ml-3"
      />
    </label>
  );
}
