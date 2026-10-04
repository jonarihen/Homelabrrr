ALTER TABLE "vm_assignments" ADD COLUMN "resource_allocation" jsonb;

UPDATE vm_assignments AS assignment
SET resource_allocation = evidence.resources
FROM (
  SELECT job.node, job.vmid,
    allocation->>'userId' AS owner_id,
    jsonb_build_object('cores', allocation->'cores', 'memoryMb', allocation->'memoryMb', 'diskGb', allocation->'diskGb') AS resources
  FROM provisioned_vms AS job
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(job.steps) = 'array' THEN job.steps ELSE '[]'::jsonb END) AS step
  CROSS JOIN LATERAL (SELECT step->'allocation' AS allocation) AS intent
  WHERE step->>'key' = 'reserve' AND allocation->>'version' = '1' AND allocation->>'state' = 'owned'
    AND jsonb_typeof(allocation->'cores') = 'number' AND jsonb_typeof(allocation->'memoryMb') = 'number'
    AND jsonb_typeof(allocation->'diskGb') = 'number'
    AND NOT EXISTS (SELECT 1 FROM provisioned_vms AS newer WHERE newer.vmid = job.vmid AND newer.id > job.id)
) AS evidence
WHERE assignment.node = evidence.node AND assignment.vmid = evidence.vmid
  AND assignment.user_id::text = evidence.owner_id AND assignment.resource_allocation IS NULL;
