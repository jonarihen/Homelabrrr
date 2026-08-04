// Shared, database-free permission vocabulary. Keep this module free of
// service imports so schema migrations can seed roles without creating a
// db.js <-> permissions.js initialization cycle.
export const PERMISSION_KEYS = [
  'see_all_vms',
  'can_operate_all_vms',
  'can_provision',
  'can_create_vms',
  'can_manage_hosts',
  'can_manage_firewalls',
  'can_manage_port_forwards',
  'can_manage_vlans',
  'can_manage_policies',
  'can_manage_templates',
  'can_manage_users',
  'can_manage_assignments',
  'can_view_audit_log',
  'can_edit_vm_hardware',
  'can_manage_websites',
  'can_manage_public_ips',
];
