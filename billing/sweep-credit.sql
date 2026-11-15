-- BIL-26: hands the wallet sweeper a command nobody announced — a Credit of 1 on admin-test's wallet, Pending, created
-- and queued 60 s ago, a new TopUp ref (the INSERT of titan-ops infra/runbooks/runbook-wallet-async.md §4, amount 1).
-- Money moves only on admin-test (CLAUDE.md). Not loaded into the runner: the agent runs it after the billing module — on
-- dev as a dev write, on the release environment as an L-x, there only until the first real customer
-- (titan-ops status/known-state.md#first-real-customer):
--   psql -U postgres -d titan -v ON_ERROR_STOP=1 -f sweep-credit.sql
-- It prints one line (mutation id, ref, balance before); no line ⇒ admin-test has no wallet, nothing was written. Then,
-- after one schedule of CronJob control-plane-job-wallet-sweep (2 minutes) and 30 s, sweep-credit-check.sql with that ref.
\set ON_ERROR_STOP on
WITH w AS (
  SELECT w.id, w.available_amount
  FROM core.wallets w JOIN core.tenants t ON t.id = w.tenant_id
  WHERE t.name = 'admin-test'
), ins AS (
  INSERT INTO core.wallet_mutations
    (id, wallet_id, type, amount, ref_type, ref_id, status, attempts, created_at, queued_at)
  SELECT gen_random_uuid(), w.id, 'Credit', 1, 'TopUp', gen_random_uuid(),
         'Pending', 0, now() - interval '60 seconds', now() - interval '60 seconds'
  FROM w
  RETURNING id, wallet_id, ref_id
)
SELECT ins.id AS mutation_id, ins.ref_id, w.available_amount AS balance_before, now() AS inserted_at
FROM ins JOIN w ON w.id = ins.wallet_id;
