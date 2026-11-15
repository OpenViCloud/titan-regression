-- BIL-26, the read after sweep-credit.sql (read only): the command must be Applied, the wallet one more than the balance
-- sweep-credit.sql printed, and the ledger must hold exactly one TopUp line with that ref
-- (titan-ops features/billing/wallet/design.md#wallet-sweeper · OpenViCloud/titan-control-plane:Titan.Infrastructure/Hosting/WalletMutationSweeper.cs (RunAsync)).
--   psql -U postgres -d titan -v ref=<ref_id printed by sweep-credit.sql> -f sweep-credit-check.sql
\set ON_ERROR_STOP on
SELECT m.status, m.applied_at, m.attempts, m.last_error, w.available_amount AS balance_now,
       (SELECT count(*) FROM core.wallet_transactions t
         WHERE t.wallet_id = m.wallet_id AND t.ref_id = m.ref_id AND t.type = 'TopUp') AS topup_lines,
       (SELECT min(t.amount) FROM core.wallet_transactions t
         WHERE t.wallet_id = m.wallet_id AND t.ref_id = m.ref_id) AS line_amount
FROM core.wallet_mutations m JOIN core.wallets w ON w.id = m.wallet_id
WHERE m.ref_id = :'ref'::uuid;
