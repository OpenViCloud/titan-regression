-- BIL-14: every wallet's stored balance equals the sum of its signed transactions
-- (titan-ops architecture/money-and-wallet.md#wallet-one-balance). Read-only; the agent runs it after the billing and
-- concurrency modules. Any row printed is a FINDING.
SELECT w.tenant_id, w.available_amount, coalesce(sum(t.amount), 0) AS ledger
FROM core.wallets w
LEFT JOIN core.wallet_transactions t ON t.wallet_id = w.id
GROUP BY w.id, w.tenant_id, w.available_amount
HAVING w.available_amount <> coalesce(sum(t.amount), 0);
