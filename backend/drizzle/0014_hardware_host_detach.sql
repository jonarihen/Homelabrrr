-- Decommissioned iLO connections must not block PVE host deletion forever.
-- 0004 created this FK inline, so PostgreSQL named it *_fkey; drop either name.
ALTER TABLE "hardware_connections" DROP CONSTRAINT IF EXISTS "hardware_connections_pve_host_id_fkey";
--> statement-breakpoint
ALTER TABLE "hardware_connections" DROP CONSTRAINT IF EXISTS "hardware_connections_pve_host_id_pve_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "hardware_connections" ALTER COLUMN "pve_host_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hardware_connections" ADD CONSTRAINT "hardware_connections_pve_host_id_pve_hosts_id_fk" FOREIGN KEY ("pve_host_id") REFERENCES "public"."pve_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hardware_connections" ADD CONSTRAINT "hardware_connections_active_host_check" CHECK ("hardware_connections"."lifecycle_state" <> 'active' OR "hardware_connections"."pve_host_id" IS NOT NULL);
