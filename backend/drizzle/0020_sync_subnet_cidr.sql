ALTER TABLE "firewall_vlan_sync" ADD COLUMN "subnet_cidr" text;--> statement-breakpoint
-- Backfill only from immutable provisioning records: the static route the
-- sync's workflow run created (`dst` "a.b.c.0 255.255.255.0" in its run log).
-- Never from current, mutable workflow settings. Rows without such a record
-- stay NULL, which readers treat as the legacy 10.x default. No casts: bad or
-- unexpected JSON yields NULL instead of aborting.
UPDATE "firewall_vlan_sync" AS s
SET "subnet_cidr" = (
  SELECT substring(c.call->'body'->>'dst' from '^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.0) 255\.255\.255\.0$') || '/24'
  FROM "workflow_runs" AS r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r."log") = 'array' THEN r."log" ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS e(entry, entry_no)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(e.entry->'calls') = 'array' THEN e.entry->'calls' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS c(call, call_no)
  WHERE r."id" = s."workflow_run_id"
    AND c.call->>'method' = 'POST' AND c.call->>'path' = 'cmdb/router/static'
    AND (c.call->'body'->>'dst') ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.0 255\.255\.255\.0$'
  ORDER BY e.entry_no, c.call_no
  LIMIT 1
)
WHERE s."subnet_cidr" IS NULL AND s."workflow_run_id" IS NOT NULL;
