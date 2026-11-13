-- BIL-25: the RUNNING_VM rows of the VM the spec kept running while run-module.sh rolled the control plane, one line per
-- meter bucket whose tick fell inside the roll window (titan-ops architecture/background-jobs.md#background-jobs ·
-- titan-ops features/billing/metering/design.md#meter-liveness). Read only. Not loaded into the runner: the agent runs it
-- after the billing module, from the `BIL-25 vm` line of runner.log and the `BIL-25 roll window` lines of run.log:
--   psql -U postgres -d titan -v vm=<vm id> -v from=<window start> -v to=<window end> -v step='1 minute' -f meter-buckets.sql
-- step is the environment's meter tick (dev: 1 minute). A bucket is the tick's time floored to the step; the last bucket
-- before the window's end is the last whose tick surely ran. Every line must read rows = 1: 0 is a tick lost to the roll,
-- 2 a tick metered twice.
\set ON_ERROR_STOP on
SELECT b AS bucket, count(u.id) AS rows
FROM generate_series(date_bin(:'step'::interval, :'from'::timestamptz, timestamptz '2000-01-01'),
                     date_bin(:'step'::interval, :'to'::timestamptz, timestamptz '2000-01-01') - :'step'::interval,
                     :'step'::interval) AS b
LEFT JOIN core.usage_records u
  ON u.bucket = b AND u.resource_id = :'vm'::uuid AND u.usage_type = 'RUNNING_VM'
GROUP BY b
ORDER BY b;
