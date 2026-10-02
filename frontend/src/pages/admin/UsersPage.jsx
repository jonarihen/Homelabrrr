import { useCallback, useState, useEffect } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useUnsavedChangesGuard from '../../hooks/useUnsavedChangesGuard.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { displayNode, vmIdentityKey } from '../../utils/nodeRef.js';
import { draftFromState, buildUserPatch, describeUserChanges, invalidQuotaKeys, oversizedAssignmentSections } from '../../utils/userDraft.js';

export default function UsersPage() {
  useDocumentTitle('Users');
  const { user: currentUser } = useAuth();
  const canGrantPrivileges = !!currentUser?.isAdmin;
  const [users, setUsers]           = useState([]);
  const [allVMs, setAllVMs]         = useState([]);
  const [allVLANs, setAllVLANs]     = useState([]);
  const [roles, setRoles]           = useState([]);
  const [invites, setInvites]       = useState([]);
  const [usage, setUsage]           = useState({});
  const [loading, setLoading]       = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [manageUser, setManageUser] = useState(null);
  const [error, setError]           = useState('');

  const load = async () => {
    try {
      const [u, v, vl, r, inv] = await Promise.all([
        api.get('/admin/users'),
        api.get('/admin/vms'),
        api.get('/admin/vlans'),
        api.get('/admin/roles'),
        api.get('/admin/invites'),
      ]);
      setUsers(u.data);
      setAllVMs(v.data);
      setAllVLANs(vl.data);
      setRoles(r.data.roles || []);
      setInvites(inv.data || []);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load');
    } finally {
      setLoading(false);
    }
    // Usage is a separate slower call — don't block the table on it
    api.get('/admin/user-usage').then(r => setUsage(r.data || {})).catch(() => {});
  };

  const loadInvites = async () => {
    try { setInvites((await api.get('/admin/invites')).data || []); } catch { /* ignore */ }
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
          <h1 className="aaris-display text-lg text-gray-100">Users</h1>
          <p className="text-sm text-gray-500 mt-0.5">{users.length} accounts</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setInviteOpen(true)}
            className="flex items-center gap-2 border border-gray-700 hover:border-gray-500 text-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Generate invite
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            + New User
          </button>
        </div>
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
                <th className="text-left px-4 py-3">Usage</th>
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
                        : u.role_name
                          ? <span className="text-xs bg-purple-900/60 text-purple-300 px-2 py-0.5 rounded">{u.role_name}</span>
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
                        // Role assigned → the role defines the permission set
                        const role = u.role_id ? roles.find(r => r.id === u.role_id) : null;
                        const count = role
                          ? role.permissions.length
                          : PERM_DEFS.filter(p => u[p.key]).length + (u.can_provision ? 1 : 0);
                        return count > 0
                          ? <span className="text-xs text-purple-400">{count} granted{role ? ' (role)' : ''}</span>
                          : <span className="text-xs text-gray-600">None</span>;
                      })()
                    }
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {u.can_operate_all_vms
                      ? <span className="text-xs text-amber-400" title="Operate all VMs — console, SSH and power control on every VM">All (operate)</span>
                      : u.see_all_vms
                        ? <span className="text-xs text-blue-400" title="View all VMs — read-only">All (view)</span>
                        : u.vm_count}
                  </td>
                  <td className="px-4 py-3">
                    <UsageCell usage={usage[u.id]} user={u} role={u.role_id ? roles.find(r => r.id === u.role_id) : null} />
                  </td>
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

      {!loading && (
        <InvitesPanel
          invites={invites}
          onChanged={loadInvites}
        />
      )}

      {createOpen && (
        <CreateUserModal
          canCreateAdmin={canGrantPrivileges}
          onClose={() => setCreateOpen(false)}
          onCreated={load}
        />
      )}

      {inviteOpen && (
        <GenerateInviteModal
          canCreateAdmin={canGrantPrivileges}
          roles={roles}
          allVLANs={allVLANs}
          onClose={() => setInviteOpen(false)}
          onCreated={loadInvites}
        />
      )}

      {manageUser && (
        <ManageUserModal
          currentUser={currentUser}
          user={manageUser}
          allVMs={allVMs}
          allVLANs={allVLANs}
          roles={roles}
          usage={usage[manageUser.id]}
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
            minLength={12}
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
  { key: 'can_edit_vm_hardware',   label: 'Edit VM Hardware',   desc: 'Change CPU, memory, and disk size on assigned VMs' },
  { key: 'can_manage_websites',    label: 'Manage Websites',    desc: 'Register the Caddy reverse proxy, see all published sites, and assign site ownership' },
  { key: 'can_manage_public_ips',  label: 'Manage Public IPs',  desc: 'Register public IP pools, reserve addresses, and assign dedicated public IPs to users' },
];

function ManageUserModal({ currentUser, user, allVMs, allVLANs, roles = [], usage, onClose }) {
  const canGrantPrivileges = !!currentUser?.isAdmin;
  const [tab, setTab]           = useState(() => canGrantPrivileges ? 'permissions' : 'vms');
  const [state, setState]       = useState(null);
  const [draft, setDraft]       = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [newPw, setNewPw]       = useState('');
  const [pwMsg, setPwMsg]       = useState('');
  const [newUsername, setNewUsername] = useState(user.username);
  const [usernameMsg, setUsernameMsg] = useState('');
  const [twoFaMsg, setTwoFaMsg] = useState('');
  const [error, setError]       = useState('');
  const [tokens, setTokens]     = useState([]);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [tokenMsg, setTokenMsg] = useState('');

  const loadState = useCallback(async () => {
    try {
      const { data } = await api.get(`/admin/users/${user.id}/state`);
      setState(data);
      setDraft(draftFromState(data));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load user');
    }
  }, [user.id]);

  useEffect(() => { loadState(); }, [loadState]);

  const reviewedRoles = state?.roleDefinitions || roles;
  const ctx = { allVMs, allVLANs, roles: reviewedRoles };
  const changes = state && draft ? describeUserChanges(state, draft, ctx) : [];
  const pending = changes.length;
  const badQuotas = draft ? invalidQuotaKeys(draft.quotas) : [];
  const oversized = state && draft ? oversizedAssignmentSections(buildUserPatch(state, draft, { allVMs })) : [];

  useUnsavedChangesGuard(pending > 0, `Discard ${pending} pending change${pending === 1 ? '' : 's'} to ${state?.username || user.username}?`);

  const requestClose = () => {
    if (pending && !confirm(`Discard ${pending} pending change${pending === 1 ? '' : 's'} to ${state?.username || user.username}?`)) return;
    onClose();
  };

  const discard = () => { if (state) setDraft(draftFromState(state)); setError(''); };

  const loadTokens = useCallback(async () => {
    try {
      const { data } = await api.get(`/admin/users/${user.id}/tokens`);
      setTokens(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load tokens');
    } finally {
      setTokensLoaded(true);
    }
  }, [user.id]);

  useEffect(() => { if (tab === 'tokens') loadTokens(); }, [tab, loadTokens]);

  const revokeToken = async (token) => {
    if (!window.confirm(`Revoke "${token.name}" belonging to ${user.username}? Any script using it loses access immediately.`)) return;
    setTokenMsg('');
    try {
      await api.delete(`/admin/tokens/${token.id}`);
      setTokenMsg('Token revoked');
      loadTokens();
    } catch (e) {
      setTokenMsg('Failed: ' + (e.response?.data?.error || 'Failed to revoke token'));
    }
  };

  const setPerm = (key, enabled) => setDraft((d) => ({ ...d, permissions: { ...d.permissions, [key]: enabled } }));
  const setRole = (value) => setDraft((d) => ({ ...d, roleId: value }));
  const setRequire2fa = (enabled) => setDraft((d) => ({ ...d, require2fa: enabled }));
  const setQuota = (key, value) => setDraft((d) => ({ ...d, quotas: { ...d.quotas, [key]: value } }));
  const toggleVm = (vm, on) => setDraft((d) => {
    const next = new Set(d.vmKeys);
    if (on) next.add(vmIdentityKey(vm)); else next.delete(vmIdentityKey(vm));
    return { ...d, vmKeys: next };
  });
  const toggleVlan = (vlan, on) => setDraft((d) => {
    const next = new Set(d.vlanIds);
    if (on) next.add(vlan.id); else next.delete(vlan.id);
    return { ...d, vlanIds: next };
  });

  const applied = (data) => {
    setState(data);
    setDraft(draftFromState(data));
    setReviewing(false);
  };

  const resetTwoFactor = async () => {
    if (!confirm(`Disable 2FA for "${user.username}"? They will be able to sign in with only their password until they re-enroll.`)) return;
    try {
      await api.post(`/admin/users/${user.id}/reset-2fa`);
      setTwoFaMsg('2FA has been disabled for this user.');
    } catch (e) { setTwoFaMsg('Failed: ' + (e.response?.data?.error || e.message)); }
  };

  const changeUsername = async (e) => {
    e.preventDefault();
    if (pending && !confirm(`Changing the username applies immediately and discards ${pending} pending change${pending === 1 ? '' : 's'}. Continue?`)) return;
    try {
      await api.put(`/admin/users/${user.id}/username`, { username: newUsername });
      await loadState();
      setUsernameMsg('Username changed. Any pending edits were discarded; review this account again before applying.');
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

  if (!state || !draft) {
    return (
      <Modal title={`Manage — ${state?.username || user.username}`} onClose={onClose} size="lg">
        <div className="p-5">
          {error
            ? <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>
            : <div className="h-24 bg-gray-800/60 rounded-lg animate-pulse" />}
        </div>
      </Modal>
    );
  }

  const isDirty = {
    role: draft.roleId !== (state.role_id == null ? '' : String(state.role_id)),
    perm: (k) => !!draft.permissions[k] !== !!state.permissions[k],
    require2fa: draft.require2fa !== !!state.require_2fa,
  };
  const baseVmKeys = new Set(state.vms.map(vmIdentityKey));
  const baseVlans = new Set(state.vlan_ids);
  const draftVMs = [
    ...state.vms.map((a) => ({ ...a, ...(allVMs.find((v) => vmIdentityKey(v) === vmIdentityKey(a)) || {}), assignmentId: a.id, node: a.node })),
    ...allVMs.filter((v) => draft.vmKeys.has(vmIdentityKey(v)) && !baseVmKeys.has(vmIdentityKey(v))),
  ];
  const assignedVMs = draftVMs.filter((v) => draft.vmKeys.has(vmIdentityKey(v)));
  const removedVMs = draftVMs.filter((v) => !draft.vmKeys.has(vmIdentityKey(v)));
  const unassignedVMs = allVMs.filter((v) => !draft.vmKeys.has(vmIdentityKey(v)) && !baseVmKeys.has(vmIdentityKey(v)));
  const assignedVLANs = allVLANs.filter((v) => draft.vlanIds.has(v.id));
  const removedVLANs = allVLANs.filter((v) => baseVlans.has(v.id) && !draft.vlanIds.has(v.id));
  const unassignedVLANs = allVLANs.filter((v) => !draft.vlanIds.has(v.id) && !baseVlans.has(v.id));
  const roleId = draft.roleId;
  const seeAllVMs = !!draft.permissions.see_all_vms;
  const operateAllVMs = !!draft.permissions.can_operate_all_vms;

  return (
    <Modal title={`Manage — ${state?.username || user.username}`} onClose={reviewing ? () => setReviewing(false) : requestClose} size="lg">
      <div className="flex border-b border-gray-700 overflow-x-auto">
        {[
          ...(canGrantPrivileges ? [{ id: 'permissions', label: 'Permissions' }] : []),
          ...(canGrantPrivileges ? [{ id: 'quotas', label: 'Quotas' }] : []),
          { id: 'vms', label: 'VM Assignments' },
          { id: 'vlans', label: 'VLAN Access' },
          { id: 'tokens', label: 'API Tokens' },
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
                <p className="text-xs text-gray-500">Control which admin features this user can access. Changes are staged — nothing is saved until you review and apply.</p>

                <div className="space-y-1">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Role</p>
                  <div className={`bg-gray-800 rounded-lg px-4 py-3 ${isDirty.role ? STAGED_CLS : ''}`}>
                    <select
                      value={roleId}
                      onChange={e => setRole(e.target.value)}
                      aria-label="Role"
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                    >
                      <option value="">No role — per-user permissions only</option>
                      {reviewedRoles.map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name} ({r.permissions.length} permission{r.permissions.length !== 1 ? 's' : ''})
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-2">
                      {roleId
                        ? 'This role fully defines the user’s permissions. Remove the role to set per-user permissions instead.'
                        : 'No role — set per-user permissions below, or assign a role to manage them centrally on the Roles page.'}
                    </p>
                  </div>
                </div>

                {roleId ? (
                  <div className="bg-purple-900/15 border border-purple-800/30 rounded-lg px-4 py-3">
                    <p className="text-sm text-purple-300 font-medium">
                      Permissions come from the “{reviewedRoles.find(r => String(r.id) === String(roleId))?.name || 'assigned'}” role
                    </p>
                    <p className="text-xs text-purple-400/70 mt-0.5">
                      Edit the role on the Roles page to change what everyone holding it can do — or remove the role above to manage this user individually.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1 pt-2">
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">VM Access</p>
                      <PermToggle
                        label="View all VMs (read-only)"
                        desc="See every VM on Proxmox without individual assignments — status, config, graphs and backup listings only. No power, console or edit rights."
                        checked={seeAllVMs}
                        staged={isDirty.perm('see_all_vms')}
                        onChange={(v) => setPerm('see_all_vms', v)}
                      />
                      <PermToggle
                        label="Operate all VMs"
                        desc="Full operator control of every VM: VNC console, SSH and SFTP shell, power on/off/reboot, snapshots, backups, VLAN and hardware changes. Console + SSH on the whole fleet is effectively root on the fleet."
                        checked={operateAllVMs}
                        staged={isDirty.perm('can_operate_all_vms')}
                        onChange={(v) => setPerm('can_operate_all_vms', v)}
                        danger
                      />
                      <PermToggle
                        label="Provision VMs"
                        desc="Allow this user to create VMs from templates"
                        checked={!!draft.permissions.can_provision}
                        staged={isDirty.perm('can_provision')}
                        onChange={(v) => setPerm('can_provision', v)}
                      />
                      <PermToggle
                        label="Create VMs"
                        desc="Build VMs from scratch / from an available ISO (self-assigned, default bridge)"
                        checked={!!draft.permissions.can_create_vms}
                        staged={isDirty.perm('can_create_vms')}
                        onChange={(v) => setPerm('can_create_vms', v)}
                      />
                    </div>

                    <div className="space-y-1 pt-2">
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Admin Features</p>
                      {PERM_DEFS.map(pDef => (
                        <PermToggle
                          key={pDef.key}
                          label={pDef.label}
                          desc={pDef.desc}
                          checked={!!draft.permissions[pDef.key]}
                          staged={isDirty.perm(pDef.key)}
                          onChange={(enabled) => setPerm(pDef.key, enabled)}
                        />
                      ))}
                    </div>
                  </>
                )}

                <div className="space-y-1 pt-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Security</p>
                  <PermToggle
                    label="Enforce 2FA"
                    desc="Force this user to enable two-factor authentication"
                    checked={draft.require2fa}
                    staged={isDirty.require2fa}
                    onChange={setRequire2fa}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {canGrantPrivileges && tab === 'quotas' && (
          <QuotasTab
            user={user}
            state={state}
            quotas={draft.quotas}
            invalid={badQuotas}
            onChange={setQuota}
            usage={usage}
            role={roleId ? reviewedRoles.find(r => String(r.id) === String(roleId)) : null}
          />
        )}

        {tab === 'vms' && (
          <div className="space-y-4">
            {(seeAllVMs || operateAllVMs) && (
              <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg px-4 py-2.5">
                <p className="text-xs text-blue-300">
                  {operateAllVMs
                    ? 'This user has "Operate all VMs" enabled — console, SSH and power control on every VM (change in Permissions tab).'
                    : 'This user has "View all VMs" enabled — read-only access to every VM (change in Permissions tab).'}
                  {' '}Assignments below still matter: only an assigned VM can be deleted, restored, or rolled back by this user.
                </p>
              </div>
            )}
            <Section title="Assigned VMs">
              {assignedVMs.length === 0 && removedVMs.length === 0
                ? <Empty text="No VMs assigned" />
                : [
                  ...assignedVMs.map(vm => (
                    <Row
                      key={vmIdentityKey(vm)}
                      label={vm.name || `VM ${vm.vmid}`}
                      sub={`${displayNode(vm.node)} · VMID ${vm.vmid}`}
                      badge={vm.status}
                      staged={baseVmKeys.has(vmIdentityKey(vm)) ? null : 'add'}
                      action={<DangerBtn onClick={() => toggleVm(vm, false)}>Remove</DangerBtn>}
                    />
                  )),
                  ...removedVMs.map(vm => (
                    <Row
                      key={vmIdentityKey(vm)}
                      label={vm.name || `VM ${vm.vmid}`}
                      sub={`${displayNode(vm.node)} · VMID ${vm.vmid}`}
                      staged="remove"
                      action={<GhostBtn onClick={() => toggleVm(vm, true)}>Undo</GhostBtn>}
                    />
                  )),
                ]
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
                    action={<BlueBtn onClick={() => toggleVm(vm, true)}>Assign</BlueBtn>}
                  />
                ))
              }
            </Section>
          </div>
        )}

        {tab === 'vlans' && (
          <div className="space-y-4">
            <Section title="Assigned VLANs">
              {assignedVLANs.length === 0 && removedVLANs.length === 0
                ? <Empty text="No VLANs assigned" />
                : [
                  ...assignedVLANs.map(v => (
                    <Row
                      key={v.id}
                      label={v.name}
                      sub={`Tag ${v.tag}${v.description ? ' · ' + v.description : ''}`}
                      staged={baseVlans.has(v.id) ? null : 'add'}
                      action={<DangerBtn onClick={() => toggleVlan(v, false)}>Remove</DangerBtn>}
                    />
                  )),
                  ...removedVLANs.map(v => (
                    <Row
                      key={v.id}
                      label={v.name}
                      sub={`Tag ${v.tag}${v.description ? ' · ' + v.description : ''}`}
                      staged="remove"
                      action={<GhostBtn onClick={() => toggleVlan(v, true)}>Undo</GhostBtn>}
                    />
                  )),
                ]
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
                    action={<BlueBtn onClick={() => toggleVlan(v, true)}>Assign</BlueBtn>}
                  />
                ))
              }
            </Section>
          </div>
        )}

        {tab === 'tokens' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Personal API tokens this user created. You can revoke any of them — the secret is never shown here.</p>
            {tokenMsg && <p role={tokenMsg.startsWith('Failed') ? 'alert' : 'status'} aria-live="polite" className={`text-xs ${tokenMsg.startsWith('Failed') ? 'text-red-400' : 'text-green-400'}`}>{tokenMsg}</p>}
            {!tokensLoaded ? (
              <div className="space-y-2">
                {[1, 2].map(i => <div key={i} className="h-12 bg-gray-800/60 rounded-lg animate-pulse" />)}
              </div>
            ) : tokens.length === 0 ? (
              <Empty text="This user has no API tokens." />
            ) : (
              <div className="space-y-1">
                {tokens.map(t => (
                  <div key={t.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-white font-mono truncate">{t.name}</p>
                        {t.expired && <span className="text-[10px] bg-red-900 text-red-300 px-1.5 py-0.5 rounded uppercase tracking-wide">Expired</span>}
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Created {tokenDate(t.createdAt)} · Expires {t.expiresAt ? tokenDate(t.expiresAt) : 'never'} · Last used {tokenDate(t.lastUsedAt)}
                      </p>
                    </div>
                    <DangerBtn onClick={() => revokeToken(t)}>Revoke</DangerBtn>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'account' && (
          <div className="space-y-6 max-w-sm">
            <p className="text-xs text-gray-500 bg-gray-800/60 rounded-lg px-3 py-2">
              Account actions below apply immediately and are not part of the staged changes.
            </p>
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
                    minLength={12}
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

      {pending > 0 && (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-amber-800/40 bg-gray-900/95 backdrop-blur px-5 py-3">
          <p className="text-sm text-amber-300">
            <span className="aaris-led aaris-led--warning aaris-led--pulse inline-block mr-2 align-middle" />
            {pending} pending change{pending === 1 ? '' : 's'}
            {badQuotas.length > 0 && <span className="ml-2 text-red-400">— fix quota values (whole numbers only)</span>}
            {oversized.length > 0 && <span className="ml-2 text-red-400">— too many changes in {oversized.join(', ')} (max 500 each)</span>}
          </p>
          <div className="flex gap-2">
            <button onClick={discard} className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors">
              Discard
            </button>
            <button
              onClick={() => setReviewing(true)}
              disabled={badQuotas.length > 0 || oversized.length > 0}
              title={badQuotas.length ? 'Quotas must be whole numbers (or empty)' : oversized.length ? 'Each VM/VLAN change list is limited to 500 items' : undefined}
              className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
            >
              Review &amp; Apply
            </button>
          </div>
        </div>
      )}

      {reviewing && (
        <ReviewUserChangesModal
          user={{ ...user, username: state.username }}
          state={state}
          draft={draft}
          changes={changes}
          allVMs={allVMs}
          onBack={() => setReviewing(false)}
          onApplied={applied}
          onStale={async (msg) => { setReviewing(false); setError(msg); await loadState(); }}
        />
      )}
    </Modal>
  );
}

function ReviewUserChangesModal({ user, state, draft, changes, allVMs, onBack, onApplied, onStale }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const dangerous = changes.some((c) => c.danger);
  const confirmed = !dangerous || typed.trim() === user.username;

  const apply = async () => {
    const body = buildUserPatch(state, draft, { allVMs });
    if (!body) { onBack(); return; }
    setBusy(true);
    setError('');
    try {
      const { data } = await api.patch(`/admin/users/${user.id}`, body);
      onApplied(data);
    } catch (e) {
      if (e.response?.status === 409) {
        onStale(`${e.response.data?.error || 'This user changed meanwhile.'} Your staged changes were discarded.`);
        return;
      }
      setError(e.response?.data?.error || 'Failed to apply changes');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Review changes — ${user.username}`} onClose={onBack} size="md">
      <div className="p-5 space-y-4">
        <p className="text-xs text-gray-400">
          These {changes.length} change{changes.length === 1 ? '' : 's'} apply together in one step — if any part fails, nothing is saved.
        </p>
        <ul className="space-y-1 font-mono text-xs bg-gray-950/60 border border-gray-800 rounded-lg p-3">
          {changes.map((c, i) => (
            <li
              key={i}
              className={c.danger ? 'text-amber-300' : c.kind === 'grant' ? 'text-green-400' : c.kind === 'revoke' ? 'text-red-400' : 'text-gray-300'}
            >
              {c.kind === 'grant' && <>+ {c.label}</>}
              {c.kind === 'revoke' && <>− {c.label}</>}
              {c.kind === 'field' && <>~ {c.label}: <span className="text-gray-500">{c.from}</span> → <span className="text-white">{c.to}</span></>}
              {c.danger && <span className="ml-2 text-[10px] uppercase tracking-wider">high blast radius</span>}
            </li>
          ))}
        </ul>
        {dangerous && (
          <div className="bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-3 space-y-2">
            <p className="text-xs text-amber-300">
              This includes a high-impact change. Type <span className="font-mono text-white">{user.username}</span> to confirm.
            </p>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Confirm username"
              autoFocus
              className={inputCls}
            />
          </div>
        )}
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg py-2.5 text-sm transition-colors">
            Back
          </button>
          <button
            onClick={apply}
            disabled={busy || !confirmed}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
          >
            {busy ? 'Applying…' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Quotas tab ───────────────────────────────────────────────────────────────

function QuotasTab({ user, state, quotas, invalid = [], onChange, usage, role }) {
  const rows = [
    { key: 'maxCores', column: 'max_cores', label: 'Max CPU cores', unit: 'cores', used: usage?.cores },
    { key: 'maxMemoryGb', column: 'max_memory_gb', label: 'Max memory', unit: 'GB', used: usage?.memoryGb },
    { key: 'maxStorageGb', column: 'max_storage_gb', label: 'Max storage', unit: 'GB', used: usage?.diskGb },
  ];

  return (
    <div className="space-y-4 max-w-md">
      {user.is_admin ? (
        <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg px-4 py-3">
          <p className="text-sm text-blue-300 font-medium">This user is an admin</p>
          <p className="text-xs text-blue-400/70 mt-0.5">Admins bypass quotas; any values set here have no effect.</p>
        </div>
      ) : (
        <p className="text-xs text-gray-500">
          Limits on the total resources allocated to this user's VMs. Empty = {role ? 'inherit from the role' : 'unlimited'}.
          Checked when the user creates a VM or raises its hardware; lowering always works.
        </p>
      )}

      {rows.map(row => {
        const roleDefault = role?.[row.column];
        const value = quotas[row.key] ?? '';
        const effective = value !== '' ? parseInt(value, 10) : roleDefault;
        const overQuota = effective != null && row.used != null && row.used >= effective;
        const staged = String(value) !== String(state.quotas[row.column] ?? '');
        return (
          <div key={row.key} className={`bg-gray-800 rounded-lg px-4 py-3 ${staged ? STAGED_CLS : ''}`}>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-white">{row.label}</label>
              {row.used != null && (
                <span className={`text-xs ${overQuota ? 'text-red-400' : 'text-gray-500'}`}>
                  {row.used} {row.unit} allocated
                </span>
              )}
            </div>
            <input
              type="number"
              min="0"
              step="1"
              placeholder={roleDefault != null ? `${roleDefault} (from role)` : 'Unlimited'}
              value={value}
              onChange={e => onChange(row.key, e.target.value)}
              aria-invalid={invalid.includes(row.key)}
              className={`${inputCls} ${invalid.includes(row.key) ? 'border-red-500' : ''}`}
            />
            {invalid.includes(row.key) && <p className="text-xs text-red-400 mt-1">Whole number of {row.unit}, or empty.</p>}
          </div>
        );
      })}
      <p className="text-xs text-gray-500">Quota edits are staged with the rest — use Review &amp; Apply below.</p>
    </div>
  );
}

// ─── Invites ──────────────────────────────────────────────────────────────────

const INVITE_STATUS_STYLES = {
  open:    'bg-green-900 text-green-300',
  used:    'bg-gray-800 text-gray-400',
  expired: 'bg-yellow-900 text-yellow-300',
  revoked: 'bg-red-900 text-red-300',
  invalid: 'bg-red-900 text-red-300',
};

function presetSummaryText(preset) {
  if (!preset) return '—';
  const bits = [];
  if (preset.isAdmin) bits.push('Admin');
  if (preset.role) bits.push(`Role: ${preset.role.name}`);
  else if (preset.grantedPermissions?.length) bits.push(`${preset.grantedPermissions.length} permission${preset.grantedPermissions.length !== 1 ? 's' : ''}`);
  if (preset.vlans?.length) bits.push(`${preset.vlans.length} VLAN${preset.vlans.length !== 1 ? 's' : ''}`);
  const q = preset.quotas || {};
  const qbits = [];
  if (q.maxCores != null) qbits.push(`${q.maxCores}c`);
  if (q.maxMemoryGb != null) qbits.push(`${q.maxMemoryGb}G RAM`);
  if (q.maxStorageGb != null) qbits.push(`${q.maxStorageGb}G disk`);
  if (qbits.length) bits.push(`Quota ${qbits.join('/')}`);
  return bits.length ? bits.join(' · ') : 'Basic user';
}

function InvitesPanel({ invites, onChanged }) {
  const [revoking, setRevoking] = useState(null); // invite pending revoke confirm
  const [error, setError] = useState('');

  const revoke = async () => {
    if (!revoking) return;
    try {
      await api.delete(`/admin/invites/${revoking.id}`);
      setRevoking(null);
      onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to revoke invite');
      setRevoking(null);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-mono text-xs font-semibold text-orange-600 tracking-[0.12em]">02</span>
        <h2 className="aaris-display text-sm text-gray-200">Invites</h2>
        <span className="text-xs text-gray-500">{invites.length} total</span>
      </div>
      {error && <p className="text-red-400 text-sm mb-3 bg-red-900/20 rounded p-2">{error}</p>}
      {invites.length === 0 ? (
        <p className="text-xs text-gray-600 italic border border-gray-800 bg-gray-900 rounded-xl px-4 py-6 text-center">
          No invites yet. Generate one to onboard a user without setting a password by hand.
        </p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Preset</th>
                <th className="text-left px-4 py-3">2FA</th>
                <th className="text-left px-4 py-3">Created by</th>
                <th className="text-left px-4 py-3">Expires</th>
                <th className="text-left px-4 py-3">Used by</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {invites.map(inv => (
                <tr key={inv.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded uppercase tracking-wide ${INVITE_STATUS_STYLES[inv.status] || 'bg-gray-800 text-gray-400'}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{presetSummaryText(inv.preset)}</td>
                  <td className="px-4 py-3 text-xs">
                    {inv.requires2fa
                      ? <span className="text-green-400">Required</span>
                      : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{inv.createdBy || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{inv.usedBy || '—'}</td>
                  <td className="px-4 py-3 text-right">
                    {inv.status === 'open' ? (
                      <button
                        onClick={() => { setError(''); setRevoking(inv); }}
                        className="text-xs text-red-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                      >
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-gray-700">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revoking && (
        <Modal title="Revoke invite" onClose={() => setRevoking(null)} size="sm">
          <div className="p-5 space-y-4">
            <p className="text-sm text-gray-300">
              Revoke this invite? The link will stop working immediately and cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRevoking(null)}
                className="text-sm text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 px-4 py-2 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={revoke}
                className="text-sm text-white bg-red-700 hover:bg-red-600 px-4 py-2 rounded-lg transition-colors"
              >
                Revoke
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GenerateInviteModal({ canCreateAdmin, roles, allVLANs, onClose, onCreated }) {
  const [form, setForm] = useState({
    isAdmin: false,
    roleId: '',
    maxCores: '',
    maxMemoryGb: '',
    maxStorageGb: '',
    expiresInDays: '7',
    require2fa: false,
  });
  const [perms, setPerms] = useState({});      // granular can_* flags (no role only)
  const [vlanIds, setVlanIds] = useState([]);  // selected VLAN ids
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);  // { url, requires2fa, ... }
  const [copied, setCopied] = useState(false);

  const usePerUser = !form.roleId;

  const togglePerm = (key) => setPerms(p => ({ ...p, [key]: !p[key] }));
  const toggleVlan = (id) => setVlanIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        isAdmin: form.isAdmin,
        roleId: form.roleId || null,
        permissions: usePerUser ? perms : {},
        maxCores: form.maxCores,
        maxMemoryGb: form.maxMemoryGb,
        maxStorageGb: form.maxStorageGb,
        vlanIds,
        expiresInDays: form.expiresInDays,
        require2fa: form.require2fa,
      };
      const r = await api.post('/admin/invites', body);
      const url = `${window.location.origin}/invite/${r.data.token}`;
      setResult({ url, requires2fa: r.data.requires2fa, expiresAt: r.data.expiresAt });
      onCreated();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to generate invite');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
  };

  if (result) {
    return (
      <Modal title="Invite created" onClose={onClose} size="md">
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-300">
            Share this single-use link. It won't be shown again — copy it now.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={result.url}
              onFocus={e => e.target.select()}
              className={`${inputCls} font-mono text-xs`}
            />
            <button
              onClick={copy}
              className="shrink-0 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="text-xs text-gray-500 space-y-1">
            <p>Expires: {result.expiresAt ? new Date(result.expiresAt).toLocaleString() : 'Never'}</p>
            {result.requires2fa && <p className="text-green-400">The invitee must enroll in 2FA before accessing the portal.</p>}
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className="text-sm text-gray-300 border border-gray-700 hover:border-gray-500 px-4 py-2 rounded-lg transition-colors">
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Generate invite" onClose={onClose} size="lg">
      <form onSubmit={submit} className="p-5 space-y-5">
        <p className="text-xs text-gray-500">
          {canCreateAdmin
            ? 'Creates a one-time link that lets someone self-register with exactly the access you pick here.'
            : 'Creates a one-time link that lets someone self-register a basic account (no roles, permissions, quotas, or VLAN access — only an admin can preload those).'}
        </p>

        {canCreateAdmin && (
          <label className="flex items-center gap-3 cursor-pointer bg-gray-800 rounded-lg px-4 py-2.5">
            <input
              type="checkbox"
              checked={form.isAdmin}
              onChange={e => setForm(f => ({ ...f, isAdmin: e.target.checked }))}
              className="accent-blue-500"
            />
            <div>
              <span className="text-sm text-gray-200">Admin account</span>
              <p className="text-xs text-gray-500">Full access. Bypasses all permission and quota checks.</p>
            </div>
          </label>
        )}

        {canCreateAdmin && !form.isAdmin && (
          <>
            <Field label="Role preset">
              <select
                value={form.roleId}
                onChange={e => setForm(f => ({ ...f, roleId: e.target.value }))}
                className={inputCls}
              >
                <option value="">No role — set individual permissions</option>
                {roles.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.permissions.length} permission{r.permissions.length !== 1 ? 's' : ''})
                  </option>
                ))}
              </select>
            </Field>

            {usePerUser && (
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Permissions</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {[
                    { key: 'see_all_vms', label: 'View all VMs (read-only)', title: 'See every VM without individual assignments — status, config, graphs and backup listings only.' },
                    { key: 'can_operate_all_vms', label: 'Operate all VMs', title: 'Console, SSH/SFTP, power, snapshots, backups, VLAN and hardware changes on every VM. Effectively root on the fleet.', danger: true },
                    { key: 'can_provision', label: 'Provision VMs' },
                    { key: 'can_create_vms', label: 'Create VMs' },
                    ...PERM_DEFS,
                  ].map(p => (
                    <label
                      key={p.key}
                      title={p.title || p.desc}
                      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                        p.danger && perms[p.key]
                          ? 'bg-amber-900/20 border border-amber-800/40 hover:bg-amber-900/25'
                          : 'bg-gray-800 hover:bg-gray-800/80'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!!perms[p.key]}
                        onChange={() => togglePerm(p.key)}
                        className="accent-blue-500 shrink-0"
                      />
                      <span className={`text-xs ${p.danger && perms[p.key] ? 'text-amber-300' : 'text-gray-300'}`}>{p.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {canCreateAdmin && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Quotas (empty = {form.roleId ? 'inherit from role' : 'unlimited'})</p>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Max cores">
                <input type="number" min="0" value={form.maxCores} placeholder="∞"
                  onChange={e => setForm(f => ({ ...f, maxCores: e.target.value }))} className={inputCls} />
              </Field>
              <Field label="Max RAM (GB)">
                <input type="number" min="0" value={form.maxMemoryGb} placeholder="∞"
                  onChange={e => setForm(f => ({ ...f, maxMemoryGb: e.target.value }))} className={inputCls} />
              </Field>
              <Field label="Max disk (GB)">
                <input type="number" min="0" value={form.maxStorageGb} placeholder="∞"
                  onChange={e => setForm(f => ({ ...f, maxStorageGb: e.target.value }))} className={inputCls} />
              </Field>
            </div>
          </div>
        )}

        {canCreateAdmin && allVLANs.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">VLAN access</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
              {allVLANs.map(v => (
                <label key={v.id} className="flex items-center gap-2.5 bg-gray-800 rounded-lg px-3 py-2 cursor-pointer hover:bg-gray-800/80 transition-colors">
                  <input
                    type="checkbox"
                    checked={vlanIds.includes(v.id)}
                    onChange={() => toggleVlan(v.id)}
                    className="accent-blue-500 shrink-0"
                  />
                  <span className="text-xs text-gray-300">{v.name} <span className="text-gray-500">· {v.tag}</span></span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Expires in (days, empty = never)">
            <input type="number" min="1" value={form.expiresInDays} placeholder="Never"
              onChange={e => setForm(f => ({ ...f, expiresInDays: e.target.value }))} className={inputCls} />
          </Field>
          <label className="flex items-center gap-3 cursor-pointer bg-gray-800 rounded-lg px-4 py-2.5 self-end">
            <input
              type="checkbox"
              checked={form.require2fa}
              onChange={e => setForm(f => ({ ...f, require2fa: e.target.checked }))}
              className="accent-blue-500"
            />
            <span className="text-sm text-gray-200">Require 2FA enrollment</span>
          </label>
        </div>

        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <button type="submit" disabled={saving} className={btnCls}>
          {saving ? 'Generating…' : 'Generate invite link'}
        </button>
      </form>
    </Modal>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';
const btnCls   = 'w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors';

function tokenDate(v) {
  if (!v) return '—';
  // ISO-8601 from the API; tolerate the legacy 'YYYY-MM-DD HH:MM:SS' UTC form.
  const s = String(v);
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  return isNaN(d.getTime()) ? v : d.toLocaleString();
}

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

const STAGED_CLS = 'border-l-2 border-l-amber-400';

function Row({ label, sub, badge, action, staged = null }) {
  const badgeColors = {
    running: 'bg-green-900 text-green-300',
    stopped: 'bg-red-900 text-red-300',
  };
  return (
    <div className={`flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5 ${staged ? STAGED_CLS : ''} ${staged === 'remove' ? 'opacity-60' : ''}`}>
      <div>
        <p className={`text-sm text-white ${staged === 'remove' ? 'line-through' : ''}`}>{label}</p>
        <p className="text-xs text-gray-500">{sub}</p>
      </div>
      <div className="flex items-center gap-2">
        {staged && (
          <span className="text-[10px] uppercase tracking-wider text-amber-400">
            {staged === 'add' ? 'pending add' : 'pending remove'}
          </span>
        )}
        {badge && <span className={`text-xs px-2 py-0.5 rounded ${badgeColors[badge] || 'bg-gray-700 text-gray-400'}`}>{badge}</span>}
        {action}
      </div>
    </div>
  );
}

function Empty({ text }) {
  return <p className="text-xs text-gray-600 italic py-2 px-3">{text}</p>;
}

// Compact per-user allocation, red per metric when at/over its effective
// quota (per-user value, else the role's default)
function UsageCell({ usage, user, role }) {
  if (!usage || usage.vmCount === 0) return <span className="text-xs text-gray-600">—</span>;
  const metric = (used, limit, suffix) => {
    const over = limit != null && used >= limit;
    return (
      <span className={over ? 'text-red-400' : ''} title={limit != null ? `${used}/${limit} ${suffix}` : `${used} ${suffix} (no limit)`}>
        {used}{suffix}
      </span>
    );
  };
  const limits = {
    cores: user.max_cores ?? role?.max_cores,
    memory: user.max_memory_gb ?? role?.max_memory_gb,
    storage: user.max_storage_gb ?? role?.max_storage_gb,
  };
  return (
    <span className="text-xs text-gray-400 font-mono whitespace-nowrap">
      {metric(usage.cores, limits.cores, 'c')} · {metric(usage.memoryGb, limits.memory, 'G')} · {metric(usage.diskGb, limits.storage, 'G')}
    </span>
  );
}

function BlueBtn({ children, onClick }) {
  return (
    <button onClick={onClick} className="text-xs px-3 py-1 bg-blue-700 hover:bg-blue-600 text-white rounded transition-colors">
      {children}
    </button>
  );
}

function GhostBtn({ children, onClick }) {
  return (
    <button onClick={onClick} className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors">
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

function PermToggle({ label, desc, checked, onChange, danger = false, staged = false }) {
  const hot = danger && checked;
  return (
    <label className={`flex items-center justify-between rounded-lg px-4 py-2.5 cursor-pointer transition-colors ${
      hot ? 'bg-amber-900/20 border border-amber-800/40 hover:bg-amber-900/25' : 'bg-gray-800 hover:bg-gray-800/80'
    } ${staged ? STAGED_CLS : ''}`}>
      <div>
        <p className="text-sm text-white">
          {label}
          {danger && <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-400">high blast radius</span>}
          {staged && <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-400">pending</span>}
        </p>
        {desc && <p className={`text-xs ${hot ? 'text-amber-300/80' : 'text-gray-500'}`}>{desc}</p>}
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
