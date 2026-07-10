import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import ChangelogPanel from './ChangelogPanel.jsx';

const navItem = 'group flex items-center gap-2.5 pl-3 pr-3 py-2 border-l-2 font-mono text-[11px] uppercase tracking-[0.08em] text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors';
const activeNav = 'border-l-orange-600 bg-gray-800 text-gray-100';
const inactiveNav = 'border-l-transparent';

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    // No bg on the shell — body paints the page color and the AARIS grid sits
    // behind it; an opaque wrapper here would blank the grid on every page.
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 border border-orange-600 text-orange-600 flex items-center justify-center">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <rect x="2" y="3" width="20" height="14" rx="0" />
                <path d="M8 21h8M12 17v4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0">
              <span className="aaris-display text-gray-100 text-sm block leading-none">VM Manager</span>
              <p className="flex items-center gap-1.5 mt-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-500 truncate">
                <span className="aaris-led aaris-led--ok" />{user?.username}
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto">
          <NavLink to="/welcome" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
            <Icon d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /> Overview
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
            <Icon d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" /> My VMs
          </NavLink>
          {(user?.isAdmin || user?.canProvision || user?.canCreateVms) && (
            <NavLink to="/provision" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
              <Icon d="M12 4.5v15m7.5-7.5h-15" /> New VM
            </NavLink>
          )}
          <NavLink to="/ssh-keys" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
            <Icon d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /> SSH Keys
          </NavLink>
          <NavLink to="/account" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
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
                      <NavLink to="/admin/hosts" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7" /> PVE Hosts
                      </NavLink>
                    )}
                    {can('canManageFirewalls') && (
                      <NavLink to="/admin/firewalls" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z" /> Firewalls
                      </NavLink>
                    )}
                    {can('canManageTemplates') && (
                      <NavLink to="/admin/templates" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /> Templates
                      </NavLink>
                    )}
                    {isAdmin && (
                      <NavLink to="/admin/leases" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /> VM Leases
                      </NavLink>
                    )}
                  </NavSection>
                )}

                {showNet && (
                  <NavSection label="Networking">
                    {can('canManageVlans') && (
                      <NavLink to="/admin/vlans" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M3 6h18M3 12h18M3 18h18" /> VLANs
                      </NavLink>
                    )}
                    {can('canManagePolicies') && (
                      <NavLink to="/admin/policies" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M15 12a3 3 0 11-6 0 3 3 0 016 0z" /> Policies
                      </NavLink>
                    )}
                    {(can('canManageFirewalls') || can('canManagePortForwards')) && (
                      <NavLink to="/admin/port-forwarding" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M9 12h6m-3-3v6" /> Port Forwarding
                      </NavLink>
                    )}
                    {can('canManageAssignments') && (
                      <NavLink to="/admin/assignments" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /> Assignments
                      </NavLink>
                    )}
                  </NavSection>
                )}

                {showAccess && (
                  <NavSection label="Access">
                    {can('canManageUsers') && (
                      <NavLink to="/admin/users" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /> Users
                      </NavLink>
                    )}
                    {can('canManageUsers') && (
                      <NavLink to="/admin/roles" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /> Roles
                      </NavLink>
                    )}
                    {can('canViewAuditLog') && (
                      <NavLink to="/admin/audit-log" className={({ isActive }) => `${navItem} ${isActive ? activeNav : inactiveNav}`}>
                        <Icon d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /> Audit Log
                      </NavLink>
                    )}
                  </NavSection>
                )}
              </>
            );
          })()}
        </nav>

        <div className="p-3 border-t border-gray-800">
          <a
            href="https://discord.gg/KMj63SbyfH"
            target="_blank"
            rel="noreferrer"
            title="Join the Discord for status updates — get notified about maintenance windows and breakdowns"
            className="group mb-3 block w-full border border-gray-800 bg-gray-900/85 px-3 py-2 text-left transition-colors hover:border-orange-600/60 hover:bg-gray-800"
          >
            <span className="flex items-center justify-between gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-gray-300 group-hover:text-gray-100 transition-colors">
              <span className="inline-flex items-center gap-2">
                <DiscordIcon />
                Discord / Status
              </span>
              <span className="text-gray-600 group-hover:text-orange-500 transition-colors">↗</span>
            </span>
            <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-gray-500">
              Maintenance + outage alerts
            </span>
          </a>
          <ChangelogPanel />
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 border-l-2 border-transparent font-mono text-[11px] uppercase tracking-[0.08em] text-gray-500 hover:text-red-400 hover:border-l-red-500 hover:bg-red-500/5 transition-colors"
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
    <div className="pt-5">
      <p className="px-3 pb-1.5 font-mono text-[9px] text-gray-600 uppercase tracking-[0.18em]">{label}</p>
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

function DiscordIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-gray-400 group-hover:text-orange-500 transition-colors" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20.317 4.37a19.79 19.79 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}
