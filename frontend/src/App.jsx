import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import { ConsoleSessionsProvider } from './contexts/ConsoleSessionsContext.jsx';
import Login from './pages/Login.jsx';
import WelcomePage from './pages/WelcomePage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import VMPage from './pages/VMPage.jsx';
import VNCPage from './pages/VNCPage.jsx';
import SSHPage from './pages/SSHPage.jsx';
import AdminLayout from './pages/admin/AdminLayout.jsx';
import UsersPage from './pages/admin/UsersPage.jsx';
import RolesPage from './pages/admin/RolesPage.jsx';
import VLANsPage from './pages/admin/VLANsPage.jsx';
import AssignmentsPage from './pages/admin/AssignmentsPage.jsx';
import PVEHostsPage from './pages/admin/PVEHostsPage.jsx';
import TemplatesPage from './pages/admin/TemplatesPage.jsx';
import AuditLogPage from './pages/admin/AuditLogPage.jsx';
import FirewallsPage from './pages/admin/FirewallsPage.jsx';
import PoliciesPage from './pages/admin/PoliciesPage.jsx';
import PortForwardingPage from './pages/admin/PortForwardingPage.jsx';
import LeasesPage from './pages/admin/LeasesPage.jsx';
import SSHKeysPage from './pages/SSHKeysPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import ProvisionPage from './pages/ProvisionPage.jsx';

function PrivateRoute({ children, allow2faBypass }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-gray-400">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  // If 2FA is required but not enabled, force user to account page to set it up
  if (user.require2fa && !user.twoFactorEnabled && !allow2faBypass) {
    return <Navigate to="/account" replace />;
  }
  return children;
}

function AdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  // Allow access if admin OR has any management permission
  const p = user.permissions || {};
  const hasAnyPerm = user.isAdmin || Object.values(p).some(v => v);
  if (!hasAnyPerm) return <Navigate to="/dashboard" replace />;
  return children;
}

function AdminIndexRedirect() {
  const { user } = useAuth();
  const p = user?.permissions || {};
  const can = (perm) => user?.isAdmin || p[perm];
  // Redirect to the first admin page the user has access to
  if (can('canManageUsers')) return <Navigate to="/admin/users" replace />;
  if (can('canManageHosts')) return <Navigate to="/admin/hosts" replace />;
  if (can('canManageFirewalls')) return <Navigate to="/admin/firewalls" replace />;
  if (can('canManageTemplates')) return <Navigate to="/admin/templates" replace />;
  if (can('canManageVlans')) return <Navigate to="/admin/vlans" replace />;
  if (can('canManagePolicies')) return <Navigate to="/admin/policies" replace />;
  if (can('canManagePortForwards')) return <Navigate to="/admin/port-forwarding" replace />;
  if (can('canManageAssignments')) return <Navigate to="/admin/assignments" replace />;
  if (can('canViewAuditLog')) return <Navigate to="/admin/audit-log" replace />;
  return <Navigate to="/dashboard" replace />;
}

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to="/welcome" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ConsoleSessionsProvider>
          <Routes>
            <Route path="/login" element={<Login />} />

            <Route path="/" element={<PrivateRoute><RootRedirect /></PrivateRoute>} />

            <Route path="/welcome" element={<PrivateRoute><WelcomePage /></PrivateRoute>} />
            <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />

            <Route path="/vm/:node/:vmid" element={<PrivateRoute><VMPage /></PrivateRoute>} />
            <Route path="/vnc/:node/:vmid" element={<PrivateRoute><VNCPage /></PrivateRoute>} />
            <Route path="/ssh/:node/:vmid" element={<PrivateRoute><SSHPage /></PrivateRoute>} />
            <Route path="/provision" element={<PrivateRoute><ProvisionPage /></PrivateRoute>} />
            <Route path="/ssh-keys" element={<PrivateRoute><SSHKeysPage /></PrivateRoute>} />
            <Route path="/account" element={<PrivateRoute allow2faBypass><AccountPage /></PrivateRoute>} />

            <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
              <Route index element={<AdminIndexRedirect />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="roles" element={<RolesPage />} />
              <Route path="vlans" element={<VLANsPage />} />
              <Route path="assignments" element={<AssignmentsPage />} />
              <Route path="hosts" element={<PVEHostsPage />} />
              <Route path="firewalls" element={<FirewallsPage />} />
              <Route path="policies" element={<PoliciesPage />} />
              <Route path="port-forwarding" element={<PortForwardingPage />} />
              <Route path="templates" element={<TemplatesPage />} />
              <Route path="leases" element={<LeasesPage />} />
              <Route path="audit-log" element={<AuditLogPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ConsoleSessionsProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
