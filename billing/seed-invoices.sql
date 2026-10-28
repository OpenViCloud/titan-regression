-- Seeds the invoices the billing and concurrency modules pay, on admin-test's tenant (money only moves there:
-- CLAUDE.md). Not loaded into the runner: the agent runs it with psql before those modules — on dev as
-- a dev write, on the release environment (prd) as an L-x of the release plan, and there only until the first real
-- customer (OpenViCloud/titan-ops:docs/status/known-state.md#first-real-customer).
--   psql -U postgres -d titan -v ON_ERROR_STOP=1 -f seed-invoices.sql
-- Each run takes the first year in 2001..2099 admin-test has no invoice in, so runs never collide and nothing
-- is deleted. Totals mark each invoice's role; the specs find them by year and total.
--   1111       tenant pays from the wallet (BIL-04, BIL-05)
--   900000000  more than the wallet holds (BIL-06)
--   2222       admin settles from the wallet (BIL-07)
--   3333       admin marks paid, money outside Titan (BIL-08)
--   4444       two pays at once (CC-03)
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  tenant uuid;
  year int;
  m int;
  totals bigint[] := ARRAY[1111, 900000000, 2222, 3333, 4444];
  invoice uuid;
BEGIN
  SELECT id INTO tenant FROM core.tenants WHERE name = 'admin-test';
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'precondition failed: no admin-test tenant';
  END IF;
  IF (SELECT count(*) FROM core.wallets WHERE tenant_id = tenant) <> 1 THEN
    RAISE EXCEPTION 'precondition failed: admin-test has no wallet';
  END IF;
  SELECT min(y) INTO year FROM generate_series(2001, 2099) AS y
    WHERE NOT EXISTS (SELECT 1 FROM core.invoices i WHERE i.tenant_id = tenant AND i.period_year = y);
  IF year IS NULL THEN
    RAISE EXCEPTION 'precondition failed: no free seed year left in 2001..2099';
  END IF;
  FOR m IN 1..array_length(totals, 1) LOOP
    invoice := gen_random_uuid();
    INSERT INTO core.invoices (id, tenant_id, period_year, period_month, status, issued_at, due_at, total, currency)
      VALUES (invoice, tenant, year, m, 'New', now() - interval '1 day', now() + interval '6 days', totals[m], 'VND');
    INSERT INTO core.invoice_items (id, invoice_id, resource_type, resource_id, resource_name, amount, currency)
      VALUES (gen_random_uuid(), invoice, 'COMPUTE', gen_random_uuid(), 'rg-seed-usage', totals[m], 'VND');
  END LOOP;
  RAISE NOTICE 'seeded admin-test invoices for year %', year;
END $$;
COMMIT;
SELECT period_year, period_month, status, total FROM core.invoices
  WHERE tenant_id = (SELECT id FROM core.tenants WHERE name = 'admin-test')
    AND period_year = (SELECT max(period_year) FROM core.invoices
                       WHERE tenant_id = (SELECT id FROM core.tenants WHERE name = 'admin-test') AND period_year < 2100)
  ORDER BY period_month;
