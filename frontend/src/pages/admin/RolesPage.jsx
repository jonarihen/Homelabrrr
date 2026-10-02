import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { PERM_GROUPS, permLabel, isDangerPerm, roleMatchesQuery, diffRole } from '../../utils/roleDiff.js';

const btnCls = 'text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors';

export default function RolesPage() {
  useDocumentTitle('Roles');
  const { user: currentUser } = useAuth();
  const isAdmin = !!currentUser?.isAdmin;
  const canViewAudit = isAdmin || !!currentUser?.permissions?.canViewAuditLog;
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageRole, setManageRole] = useState(null);
  const [cloneSource, setCloneSource] = useState(null);
  const [holdersRole, setHoldersRole] = useState(null);
  const [deletingRole, setDeletingRole] = useState(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState('');
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

  const visible = useMemo(() => roles.filter((r) => roleMatchesQuery(r, query)), [roles, query]);

  const toggleExpanded = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const exportRole = (role) => {
    const payload = {
      kind: 'homelabrrr-role',
      version: 1,
      name: role.name,
      description: role.description || '',
      permissions: [...role.permissions].sort(),
      maxCores: role.max_cores,
      maxMemoryGb: role.max_memory_gb,
      maxStorageGb: role.max_storage_gb,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `role-${role.name.replace(/[^a-z0-9-_]+/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="aaris-display text-lg text-gray-100">Roles</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Named permission sets — assign a role to a user on the Users page. Editing a role updates everyone who holds it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {roles.length > 1 && (
            <button
              onClick={() => setCompareOpen(true)}
              className="text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 rounded-lg transition-colors"
            >
              Compare
            </button>
          )}
          {isAdmin && (
            <>
              <button
                onClick={() => setImportOpen(true)}
                className="text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 rounded-lg transition-colors"
              >
                Import
              </button>
              <button
                onClick={() => setCreateOpen(true)}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                + New Role
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="text-red-400 text-sm mb-4 bg-red-900/20 rounded p-3">{error}</p>}

      {!loading && roles.length > 0 && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, description or permission…"
          aria-label="Filter roles"
          className="w-full sm:w-80 mb-4 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
        />
      )}

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
              {visible.length === 0 && (
                <tr><td colSpan="4" className="px-4 py-6 text-center text-gray-500 text-sm">No roles match “{query}”.</td></tr>
              )}
              {visible.map(role => {
                const open = expanded.has(role.id);
                const hasDanger = role.permissions.some(isDangerPerm);
                return (
                  <tr key={role.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors align-top">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{role.name}</span>
                        {role.builtIn && <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">Built-in</span>}
                      </div>
                      {role.description && <p className="text-xs text-gray-500 mt-0.5">{role.description}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {role.permissions.length > 0 ? (
                        <button
                          onClick={() => toggleExpanded(role.id)}
                          aria-expanded={open}
                          className="text-xs text-purple-400 hover:text-purple-300 inline-flex items-center gap-1"
                        >
                          <span className="font-mono">{open ? '▾' : '▸'}</span>
                          {role.permissions.length} granted
                          {hasDanger && <span className="ml-1 text-[10px] uppercase tracking-wider text-amber-400">high blast radius</span>}
                        </button>
                      ) : <span className="text-xs text-gray-600">None</span>}
                      {open && (
                        <ul className="mt-2 flex flex-wrap gap-1">
                          {[...role.permissions].sort().map((k) => (
                            <li
                              key={k}
                              className={`text-[11px] px-2 py-0.5 rounded border ${isDangerPerm(k)
                                ? 'bg-amber-900/20 border-amber-800/40 text-amber-300'
                                : 'bg-gray-800 border-gray-700 text-gray-300'}`}
                            >
                              {permLabel(k)}
                            </li>
                          ))}
                        </ul>
                      )}
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
                      <button
                        onClick={() => setHoldersRole(role)}
                        className="text-gray-300 hover:text-white underline decoration-dotted underline-offset-4"
                        title="Show users holding this role"
                      >
                        {role.userCount}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1 flex-wrap">
                        {isAdmin && (
                          <button onClick={() => setManageRole(role)} className={`${btnCls} text-blue-400 hover:text-blue-300`}>
                            Manage
                          </button>
                        )}
                        {isAdmin && (
                          <button onClick={() => setCloneSource(role)} className={`${btnCls} text-gray-300 hover:text-white`}>
                            Clone
                          </button>
                        )}
                        <button onClick={() => exportRole(role)} className={`${btnCls} text-gray-400 hover:text-white`}>
                          Export
                        </button>
                        {canViewAudit && (
                          <Link
                            to={`/admin/audit-log?target=${encodeURIComponent(role.name)}`}
                            className={`${btnCls} text-gray-400 hover:text-white`}
                          >
                            History
                          </Link>
                        )}
                        {isAdmin && !role.builtIn && (
                          <button onClick={() => setDeletingRole(role)} className={`${btnCls} text-red-500 hover:text-red-400`}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <RoleModal
          prefill={typeof createOpen === 'object' ? createOpen : undefined}
          onClose={() => setCreateOpen(false)}
          onSaved={load}
        />
      )}
      {manageRole && <RoleModal role={manageRole} onClose={() => setManageRole(null)} onSaved={load} />}
      {cloneSource && <CloneRoleModal source={cloneSource} onClose={() => setCloneSource(null)} onSaved={load} />}
      {holdersRole && <HoldersModal role={holdersRole} isAdmin={isAdmin} onClose={() => setHoldersRole(null)} onChanged={load} />}
      {deletingRole && <DeleteRoleModal role={deletingRole} roles={roles} onClose={() => setDeletingRole(null)} onDeleted={load} />}
      {compareOpen && <CompareRolesModal roles={roles} onClose={() => setCompareOpen(false)} />}
      {importOpen && <ImportRoleModal onClose={() => setImportOpen(false)} onImported={(prefill) => { setImportOpen(false); setCreateOpen(prefill); }} />}
    </div>
  );
}

function ChangeList({ changes }) {
  if (changes.length === 0) return <p className="text-xs text-gray-500">No changes.</p>;
  return (
    <ul className="space-y-1 font-mono text-xs">
      {changes.map((c, i) => (
        <li
          key={i}
          className={
            c.kind === 'grant'
              ? (c.danger ? 'text-amber-300' : 'text-green-400')
              : c.kind === 'revoke' ? 'text-red-400' : 'text-gray-300'
          }
        >
          {c.kind === 'grant' && <>+ {c.label}{c.danger && <span className="ml-2 text-[10px] uppercase tracking-wider">high blast radius</span>}</>}
          {c.kind === 'revoke' && <>− {c.label}</>}
          {c.kind === 'field' && <>~ {c.label}: <span className="text-gray-500">{c.from}</span> → <span className="text-white">{c.to}</span></>}
        </li>
      ))}
    </ul>
  );
}

// Create + edit share one modal; `role` present = edit mode. `prefill` seeds a
// new role (used by Import).
function RoleModal({ role, prefill, onClose, onSaved }) {
  const editing = !!role;
  const seed = role || prefill || null;
  const initial = useMemo(() => ({
    name: seed?.name || '',
    description: seed?.description || '',
    permissions: [...(seed?.permissions || [])].sort(),
    maxCores: seed?.max_cores ?? seed?.maxCores ?? '',
    maxMemoryGb: seed?.max_memory_gb ?? seed?.maxMemoryGb ?? '',
    maxStorageGb: seed?.max_storage_gb ?? seed?.maxStorageGb ?? '',
  }), [seed]);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [perms, setPerms] = useState(() => new Set(initial.permissions));
  const [quotas, setQuotas] = useState({
    maxCores: initial.maxCores,
    maxMemoryGb: initial.maxMemoryGb,
    maxStorageGb: initial.maxStorageGb,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const draft = { name, description, permissions: [...perms], ...quotas };
  const changes = diffRole(editing ? role : null, draft);
  const dirty = editing
    ? changes.length > 0
    : JSON.stringify({ ...draft, permissions: [...perms].sort() }) !== JSON.stringify(initial) || !!prefill;

  const requestClose = () => {
    if (dirty && !saving && !confirm('Discard unsaved changes to this role?')) return;
    onClose();
  };

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const toggle = (key) => {
    setPerms(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setGroup = (group, on) => {
    setPerms(prev => {
      const next = new Set(prev);
      for (const p of group.perms) {
        if (on) next.add(p.key); else next.delete(p.key);
      }
      return next;
    });
  };

  const save = async () => {
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
      setReviewing(false);
    } finally {
      setSaving(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (editing && changes.length === 0) { onClose(); return; }
    setReviewing(true);
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';

  if (reviewing) {
    const holders = editing ? role.userCount : 0;
    return (
      <Modal title={editing ? `Review changes — ${role.name}` : 'Review new role'} onClose={() => setReviewing(false)} size="md">
        <div className="p-5 space-y-4">
          {editing && holders > 0 && (
            <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
              This changes effective permissions for <strong>{holders}</strong> user{holders === 1 ? '' : 's'} holding this role.
            </p>
          )}
          <ChangeList changes={changes} />
          {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setReviewing(false)}
              className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg py-2.5 text-sm transition-colors"
            >
              Back
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
            >
              {saving ? 'Applying…' : editing ? 'Apply changes' : 'Create role'}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={editing ? `Role — ${role.name}` : 'Create Role'} onClose={requestClose} size="lg">
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

        {PERM_GROUPS.map(group => {
          const all = group.perms.every((p) => perms.has(p.key));
          const none = group.perms.every((p) => !perms.has(p.key));
          return (
            <div key={group.label} className="space-y-1">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-gray-500 uppercase tracking-wider">{group.label}</p>
                <div className="flex gap-2 text-xs">
                  <button type="button" disabled={all} onClick={() => setGroup(group, true)} className="text-blue-400 hover:text-blue-300 disabled:text-gray-600">Select all</button>
                  <span className="text-gray-700">·</span>
                  <button type="button" disabled={none} onClick={() => setGroup(group, false)} className="text-blue-400 hover:text-blue-300 disabled:text-gray-600">Clear</button>
                </div>
              </div>
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
          );
        })}

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
                  value={quotas[q.key] ?? ''}
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
          disabled={saving || (editing && changes.length === 0)}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
        >
          {editing
            ? (changes.length === 0 ? 'No changes' : `Review ${changes.length} change${changes.length === 1 ? '' : 's'}`)
            : 'Review & create'}
        </button>
      </form>
    </Modal>
  );
}

function CloneRoleModal({ source, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post(`/admin/roles/${source.id}/clone`, name.trim() ? { name: name.trim() } : {});
      onSaved();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to clone role');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Clone — ${source.name}`} onClose={onClose} size="sm">
      <form onSubmit={submit} className="p-5 space-y-4">
        <p className="text-xs text-gray-400">
          Copies {source.permissions.length} permission{source.permissions.length === 1 ? '' : 's'}, quotas and description into a new, editable role. Users holding “{source.name}” are not moved.
        </p>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">New role name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${source.name} (copy)`}
            autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
          />
          <p className="text-[11px] text-gray-500 mt-1">Leave empty to use the next free “(copy)” name.</p>
        </div>
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
        >
          {saving ? 'Cloning…' : 'Clone role'}
        </button>
      </form>
    </Modal>
  );
}

function HoldersModal({ role, isAdmin, onClose, onChanged }) {
  const [holders, setHolders] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [h, u] = await Promise.all([
        api.get(`/admin/roles/${role.id}/users`),
        isAdmin ? api.get('/admin/users') : Promise.resolve({ data: [] }),
      ]);
      setHolders(h.data);
      setAllUsers(u.data || []);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load holders');
    }
  };

  useEffect(() => { load(); }, [role.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const holderIds = new Set((holders || []).map((u) => u.id));
  const candidates = allUsers.filter((u) => !holderIds.has(u.id));

  const assign = async () => {
    if (selected.size === 0) return;
    const names = candidates.filter((u) => selected.has(u.id)).map((u) => u.username);
    const moving = candidates.filter((u) => selected.has(u.id) && u.role_id).length;
    if (!confirm(`Assign “${role.name}” to ${names.length} user${names.length === 1 ? '' : 's'} (${names.join(', ')})?${moving ? `\n\n${moving} of them will lose their current role.` : ''}`)) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/admin/roles/${role.id}/assign`, { userIds: [...selected] });
      setSelected(new Set());
      await load();
      onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to assign role');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Holders — ${role.name}`} onClose={onClose} size="md">
      <div className="p-5 space-y-5">
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Current holders</p>
          {holders === null ? (
            <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
          ) : holders.length === 0 ? (
            <p className="text-sm text-gray-500">Nobody holds this role.</p>
          ) : (
            <ul className="divide-y divide-gray-800 border border-gray-800 rounded-lg">
              {holders.map((u) => (
                <li key={u.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-white">{u.username}</span>
                  {u.is_admin && <span className="text-[10px] uppercase tracking-wider text-blue-400">admin</span>}
                </li>
              ))}
            </ul>
          )}
          <Link to="/admin/users" className="inline-block mt-2 text-xs text-blue-400 hover:text-blue-300">Open Users page →</Link>
        </div>

        {isAdmin && candidates.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Assign to more users</p>
            <ul className="max-h-56 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800">
              {candidates.map((u) => (
                <li key={u.id}>
                  <label className="flex items-center justify-between px-3 py-2 text-sm cursor-pointer hover:bg-gray-800/60">
                    <span className="text-gray-200">
                      {u.username}
                      {u.role_name && <span className="ml-2 text-xs text-gray-500">currently {u.role_name}</span>}
                    </span>
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(u.id)) next.delete(u.id); else next.add(u.id);
                        return next;
                      })}
                      className="accent-blue-500 w-4 h-4"
                    />
                  </label>
                </li>
              ))}
            </ul>
            <button
              onClick={assign}
              disabled={busy || selected.size === 0}
              className="mt-3 w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-medium transition-colors"
            >
              {busy ? 'Assigning…' : `Assign to ${selected.size} selected`}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function DeleteRoleModal({ role, roles, onClose, onDeleted }) {
  const [reassignTo, setReassignTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const others = roles.filter((r) => r.id !== role.id);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.delete(`/admin/roles/${role.id}`, { params: reassignTo ? { reassignTo } : {} });
      onDeleted();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete role');
    } finally {
      setBusy(false);
    }
  };

  const target = others.find((r) => String(r.id) === String(reassignTo));

  return (
    <Modal title={`Delete role — ${role.name}`} onClose={onClose} size="sm">
      <div className="p-5 space-y-4">
        {role.userCount > 0 ? (
          <>
            <p className="text-sm text-gray-300">
              <strong className="text-white">{role.userCount}</strong> user{role.userCount === 1 ? '' : 's'} hold this role.
            </p>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Move them to</label>
              <select
                value={reassignTo}
                onChange={(e) => setReassignTo(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                <option value="">No role (per-user permissions only)</option>
                {others.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <p className="text-xs text-gray-500">
              {target
                ? `Holders will get the permissions and quotas of “${target.name}”.`
                : 'Holders fall back to their per-user permissions and quotas.'}
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-300">Nobody holds this role.</p>
        )}
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg py-2 text-sm transition-colors">Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-medium transition-colors"
          >
            {busy ? 'Deleting…' : 'Delete role'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CompareRolesModal({ roles, onClose }) {
  const [leftId, setLeftId] = useState(String(roles[0]?.id ?? ''));
  const [rightId, setRightId] = useState(String(roles[1]?.id ?? ''));
  const left = roles.find((r) => String(r.id) === leftId);
  const right = roles.find((r) => String(r.id) === rightId);

  const selectCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500';
  const quota = (r, col, unit) => (r?.[col] == null ? '∞' : `${r[col]}${unit}`);
  const rows = [
    ...PERM_GROUPS.flatMap((g) => g.perms.map((p) => ({
      key: p.key, label: p.label, danger: p.danger,
      a: left?.permissions.includes(p.key) ? '✓' : '—',
      b: right?.permissions.includes(p.key) ? '✓' : '—',
    }))),
    { key: 'q1', label: 'Max CPU cores', a: quota(left, 'max_cores', ''), b: quota(right, 'max_cores', '') },
    { key: 'q2', label: 'Max memory', a: quota(left, 'max_memory_gb', ' GB'), b: quota(right, 'max_memory_gb', ' GB') },
    { key: 'q3', label: 'Max storage', a: quota(left, 'max_storage_gb', ' GB'), b: quota(right, 'max_storage_gb', ' GB') },
  ];

  return (
    <Modal title="Compare roles" onClose={onClose} size="lg">
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <select value={leftId} onChange={(e) => setLeftId(e.target.value)} className={selectCls} aria-label="Left role">
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={rightId} onChange={(e) => setRightId(e.target.value)} className={selectCls} aria-label="Right role">
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
              <th className="text-left py-2">Permission / quota</th>
              <th className="text-center py-2 w-32 truncate">{left?.name}</th>
              <th className="text-center py-2 w-32 truncate">{right?.name}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const differs = r.a !== r.b;
              return (
                <tr key={r.key} className={`border-b border-gray-800/60 ${differs ? 'bg-blue-900/10' : ''}`}>
                  <td className={`py-1.5 ${differs ? 'text-white' : 'text-gray-500'}`}>
                    {r.label}
                    {r.danger && <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-400">high blast radius</span>}
                  </td>
                  <td className={`text-center font-mono ${differs ? 'text-white' : 'text-gray-600'}`}>{r.a}</td>
                  <td className={`text-center font-mono ${differs ? 'text-white' : 'text-gray-600'}`}>{r.b}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function ImportRoleModal({ onClose, onImported }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const parse = () => {
    setError('');
    let data;
    try { data = JSON.parse(text); } catch { setError('Not valid JSON'); return; }
    if (!data || data.kind !== 'homelabrrr-role' || typeof data.name !== 'string' || !Array.isArray(data.permissions)) {
      setError('Not a Homelabrrr role export');
      return;
    }
    onImported({
      name: data.name,
      description: typeof data.description === 'string' ? data.description : '',
      permissions: data.permissions.filter((p) => typeof p === 'string'),
      maxCores: data.maxCores ?? '',
      maxMemoryGb: data.maxMemoryGb ?? '',
      maxStorageGb: data.maxStorageGb ?? '',
    });
  };

  const readFile = async (e) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
  };

  return (
    <Modal title="Import role" onClose={onClose} size="md">
      <div className="p-5 space-y-4">
        <p className="text-xs text-gray-400">
          Paste or load a role exported from another Homelabrrr instance. It opens in the create form so you can review it before saving; unknown permission keys are rejected by the server.
        </p>
        <input type="file" accept="application/json,.json" onChange={readFile} className="text-xs text-gray-400" />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-blue-500"
        />
        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}
        <button
          onClick={parse}
          disabled={!text.trim()}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
        >
          Continue
        </button>
      </div>
    </Modal>
  );
}
