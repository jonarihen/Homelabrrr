ALTER TABLE "firewall_vlan_sync" ADD COLUMN "subnet_cidr" text;--> statement-breakpoint
-- Backfill the network each existing sync provisioned. Workflow-provisioned rows
-- (artifacts recorded) used the firewall's vlan_provision subnet.firstOctet
-- (best available record: the current setting); pre-workflow rows always used 10.
UPDATE "firewall_vlan_sync" AS s
SET "subnet_cidr" = concat(
  COALESCE((
    SELECT (w."settings"->'subnet'->>'firstOctet')::int::text
    FROM "workflows" AS w
    WHERE s."artifacts" IS NOT NULL
      AND w."firewall_id" = s."firewall_id" AND w."trigger" = 'vlan_provision'
      AND w."settings"->'subnet'->>'firstOctet' ~ '^[0-9]{1,3}$'
      AND (w."settings"->'subnet'->>'firstOctet')::int <= 255
  ), '10'),
  '.', v."tag" / 100, '.', v."tag" % 100, '.0/24')
FROM "vlans" AS v
WHERE v."id" = s."vlan_id" AND v."mode" <> 'tagged_only' AND v."tag" BETWEEN 0 AND 9999;
