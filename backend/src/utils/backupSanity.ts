import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';

export type BackupSanity = {
  schema_migrations: string;
  users: string;
  roles: string;
  settings: string;
  pve_hosts: string;
  firewalls: string;
  vm_assignments: string;
  provisioned_vms: string;
  vlans: string;
};

export async function readBackupSanity(database: Pick<DbOrTx, 'execute'>): Promise<BackupSanity> {
  const result = await database.execute(sql`
    SELECT
      (SELECT count(*)::text FROM public.schema_migrations) AS schema_migrations,
      (SELECT count(*)::text FROM public.users) AS users,
      (SELECT count(*)::text FROM public.roles) AS roles,
      (SELECT count(*)::text FROM public.settings) AS settings,
      (SELECT count(*)::text FROM public.pve_hosts) AS pve_hosts,
      (SELECT count(*)::text FROM public.firewalls) AS firewalls,
      (SELECT count(*)::text FROM public.vm_assignments) AS vm_assignments,
      (SELECT count(*)::text FROM public.provisioned_vms) AS provisioned_vms,
      (SELECT count(*)::text FROM public.vlans) AS vlans
  `);
  const sanity = result.rows[0] as BackupSanity;
  if (!sanity || Number(sanity.schema_migrations) < 1) {
    throw new Error('Backup database has no applied migrations');
  }
  return sanity;
}
