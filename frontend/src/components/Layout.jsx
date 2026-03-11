import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import AdminChangelogPanel from './AdminChangelogPanel.jsx';

const navItem = 'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800/70 transition-all';
const activeNav = 'bg-gray-800 text-white';

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-gray-900/50 border-r border-gray-800/50 flex flex-col backdrop-blur-sm">
        <div className="px-4 py-5 border-b border-gray-800/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <span className="text-white font-bold text-sm tracking-tight">VM Manager</span>
              <p className="text-xs text-gray-500 truncate">{user?.username}</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5">
          <NavLink to="/dashboard" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
            <Icon d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /> My VMs
          </NavLink>
          {(user?.isAdmin || user?.canProvision) && (
            <NavLink to="/provision" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
              <Icon d="M12 4.5v15m7.5-7.5h-15" /> New VM
            </NavLink>
          )}
          <NavLink to="/ssh-keys" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
            <Icon d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /> SSH Keys
          </NavLink>
          <NavLink to="/account" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
            <Icon d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /> Account
          </NavLink>

          {(() => {
            const isAdmin = user?.isAdmin;
            const p = user?.permissions || {};
            const can = (perm) => isAdmin || p[perm];
            const showInfra = can('canManageHosts') || can('canManageFirewalls') || can('canManageTemplates');
            const showNet = can('canManageVlans') || can('canManagePolicies') || can('canManageAssignments');
            const showAccess = can('canManageUsers') || can('canViewAuditLog');
            if (!showInfra && !showNet && !showAccess) return null;
            return (
              <>
                {showInfra && (
                  <NavSection label="Infrastructure">
                    {can('canManageHosts') && (
                      <NavLink to="/admin/hosts" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7" /> PVE Hosts
                      </NavLink>
                    )}
                    {can('canManageFirewalls') && (
                      <NavLink to="/admin/firewalls" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z" /> Firewalls
                      </NavLink>
                    )}
                    {can('canManageTemplates') && (
                      <NavLink to="/admin/templates" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /> Templates
                      </NavLink>
                    )}
                  </NavSection>
                )}

                {showNet && (
                  <NavSection label="Networking">
                    {can('canManageVlans') && (
                      <NavLink to="/admin/vlans" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M3 6h18M3 12h18M3 18h18" /> VLANs
                      </NavLink>
                    )}
                    {can('canManagePolicies') && (
                      <NavLink to="/admin/policies" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M15 12a3 3 0 11-6 0 3 3 0 016 0z" /> Policies
                      </NavLink>
                    )}
                    {can('canManageAssignments') && (
                      <NavLink to="/admin/assignments" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /> Assignments
                      </NavLink>
                    )}
                  </NavSection>
                )}

                {showAccess && (
                  <NavSection label="Access">
                    {can('canManageUsers') && (
                      <NavLink to="/admin/users" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /> Users
                      </NavLink>
                    )}
                    {can('canViewAuditLog') && (
                      <NavLink to="/admin/audit-log" className={({ isActive }) => `${navItem} ${isActive ? activeNav : ''}`}>
                        <Icon d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /> Audit Log
                      </NavLink>
                    )}
                  </NavSection>
                )}
              </>
            );
          })()}
        </nav>

        <div className="p-3 border-t border-gray-800/50">
          {user?.isAdmin && <AdminChangelogPanel />}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-red-400 hover:bg-red-500/5 transition-all"
          >
            <Icon d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}

function NavSection({ label, children }) {
  return (
    <div className="pt-4">
      <p className="px-3 pb-1 text-[10px] text-gray-600 uppercase tracking-widest font-semibold">{label}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Icon({ d }) {
  return (
    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}
