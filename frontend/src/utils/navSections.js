// The admin section of the sidebar, as data.
//
// A section's visibility is DERIVED from its links: it renders exactly when at
// least one of its links is visible, never from a separately maintained gate.
// The hand-written section gates that used to live in Layout.jsx drifted from
// the per-link gates and hid /admin/port-forwarding from users whose only grant
// was canManagePortForwards — the whole point of the scoped self-service
// port-forward flow. Keeping one source of truth makes that class of bug
// unrepresentable: if a link is visible, its section is too.
//
// Each link declares the permissions that reveal it (any one of them is
// enough). ADMIN_ONLY is the sentinel for links no granular permission can
// unlock — only a full admin sees them.

export const ADMIN_ONLY = 'isAdmin';

export const NAV_SECTIONS = [
  {
    label: 'Infrastructure',
    links: [
      {
        to: '/admin/hosts',
        label: 'PVE Hosts',
        perms: ['canManageHosts'],
        icon: 'M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7',
      },
      {
        to: '/admin/operations',
        label: 'Operations',
        perms: ['canManageHosts'],
        icon: 'M4.5 12a7.5 7.5 0 0112.78-5.303M19.5 12a7.5 7.5 0 01-12.78 5.303M16.5 3.75v3.75h-3.75M7.5 20.25V16.5h3.75',
      },
      {
        to: '/admin/firewalls',
        label: 'Firewalls',
        perms: ['canManageFirewalls'],
        icon: 'M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.286zm0 13.036h.008v.008H12v-.008z',
      },
      {
        to: '/admin/workflows',
        label: 'Workflows',
        perms: ['canManageFirewalls'],
        icon: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z',
      },
      {
        to: '/admin/templates',
        label: 'Templates',
        perms: ['canManageTemplates'],
        icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
      },
      {
        to: '/admin/leases',
        label: 'VM Leases',
        perms: [ADMIN_ONLY],
        icon: 'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
      },
    ],
  },
  {
    label: 'Networking',
    links: [
      {
        to: '/admin/vlans',
        label: 'VLANs',
        perms: ['canManageVlans'],
        icon: 'M3 6h18M3 12h18M3 18h18',
      },
      {
        to: '/admin/policies',
        label: 'Policies',
        perms: ['canManagePolicies'],
        icon: 'M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M15 12a3 3 0 11-6 0 3 3 0 016 0z',
      },
      {
        to: '/admin/port-forwarding',
        label: 'Port Forwarding',
        perms: ['canManageFirewalls', 'canManagePortForwards'],
        icon: 'M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M9 12h6m-3-3v6',
      },
      {
        to: '/admin/websites',
        label: 'Websites',
        perms: ['canManageWebsites'],
        icon: 'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418',
      },
      {
        to: '/admin/assignments',
        label: 'Assignments',
        perms: ['canManageAssignments'],
        icon: 'M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
      },
    ],
  },
  {
    label: 'Access',
    links: [
      {
        to: '/admin/users',
        label: 'Users',
        perms: ['canManageUsers'],
        icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
      },
      {
        to: '/admin/roles',
        label: 'Roles',
        perms: ['canManageUsers'],
        icon: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
      },
      {
        to: '/admin/notifications',
        label: 'Notifications',
        perms: [ADMIN_ONLY],
        icon: 'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0',
      },
      {
        to: '/admin/audit-log',
        label: 'Audit Log',
        perms: ['canViewAuditLog'],
        icon: 'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
      },
    ],
  },
];

// Builds the permission predicate the sidebar is filtered with. Admins pass
// everything, including ADMIN_ONLY; everyone else is judged purely on their
// granular `permissions` map — a non-admin can never satisfy ADMIN_ONLY.
export function makeCan(user) {
  const isAdmin = !!user?.isAdmin;
  const perms = user?.permissions || {};
  return (perm) => (perm === ADMIN_ONLY ? isAdmin : isAdmin || !!perms[perm]);
}

// The sections to render, each carrying only the links `can` allows. Sections
// with no visible links are dropped, so a section can never exist without a
// reachable link and a reachable link can never be orphaned by a hidden
// section. Pure: same `can`, same output; nothing here touches React or state.
export function visibleSections(can) {
  const allowed = typeof can === 'function' ? can : () => false;
  return NAV_SECTIONS
    .map((section) => ({
      ...section,
      links: section.links.filter((link) => link.perms.some((perm) => !!allowed(perm))),
    }))
    .filter((section) => section.links.length > 0);
}

export function adminRoutePermissions(path) {
  for (const section of NAV_SECTIONS) {
    const link = section.links.find((entry) => entry.to === path);
    if (link) return link.perms;
  }
  return [];
}
