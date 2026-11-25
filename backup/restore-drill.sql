-- BAK-24 (plan.md), the agent's read-only part: every restore drill row of today and yesterday (UTC) in
-- core.provider_commands, one line per row, with the payload's fields and the status of the drilled disk's backup row of
-- the drill's day (titan-ops features/backup/design.md#restore-drill ·
-- OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ProviderCommand/Enums/BackupCommandKeys.cs RestoreDrill, Vm, Volume ·
-- OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/ScheduleBackupsCommandHandler.cs AskRestoreDrillAsync).
-- Read only. Not used by the runner: the agent runs it before the backup module, again until today's row of the cluster
-- is neither Pending nor Leased, and logs every read in the run's evidence:
--   kubectl exec -i -n <namespace> <titan-db primary pod> -c postgres -- psql -U postgres -d titan -x < backup/restore-drill.sql
-- Today's row of the cluster passes when rows_for_key = 1, kind = restore.drill, no_tenant and no_resource are t, status
-- is Done, p_kind is vm or volume, p_resource_id, p_external_id, p_name and p_tenant_id are set, p_project_name starts
-- with t- and backup_of_the_day is Done; yesterday's row (if any) has rows_for_key = 1 too. Failed is a FAIL (last_error
-- names the failing step), except a p_name rg-bak22-* whose last_error says "is not in project" (NOT COVERED, plan.md).
-- No row of today, or Pending or Leased at the last read: NOT COVERED. After the module, p_kind and p_name of today's
-- Done row equal kind and name of the spec's `BAK-24 drill` line.
\set ON_ERROR_STOP on
WITH days AS (
  SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYYMMDD') AS today,
         to_char((now() AT TIME ZONE 'UTC')::date - 1, 'YYYYMMDD') AS yesterday,
         date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 day' AS since
)
SELECT now() AS read_at,
       c.key,
       count(*) OVER (PARTITION BY c.key) AS rows_for_key,
       c.kind,
       c.cluster_id,
       c.status,
       c.attempts,
       c.created_at,
       c.tenant_id IS NULL AS no_tenant,
       c.resource_id IS NULL AS no_resource,
       c.payload ->> 'kind' AS p_kind,
       c.payload ->> 'resourceId' AS p_resource_id,
       c.payload ->> 'externalId' AS p_external_id,
       c.payload ->> 'name' AS p_name,
       c.payload ->> 'projectName' AS p_project_name,
       c.payload ->> 'tenantId' AS p_tenant_id,
       b.status AS backup_of_the_day,
       c.last_error
FROM core.provider_commands c
CROSS JOIN days d
LEFT JOIN core.provider_commands b
  ON b.key = (c.payload ->> 'kind') || '-backup-' || (c.payload ->> 'resourceId') || '-' || right(c.key, 8)
WHERE (c.key LIKE 'restore-drill-%' AND right(c.key, 8) IN (d.today, d.yesterday))
   OR (c.kind = 'restore.drill' AND c.created_at >= d.since)
ORDER BY c.cluster_id, c.key;
