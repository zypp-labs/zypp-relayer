-- Extend job_status with the two values the relayer already writes.
--
-- 001_initial.sql declared only ('queued','sent','confirmed','failed'), but
-- src/lib/constants.ts declares six. The relayer writes 'shunted'
-- (src/api/routes.ts — degraded/shunt path) and 'acknowledged'
-- (non-execution intents), both of which Postgres rejected with
-- "invalid input value for enum job_status". The shunt broadcast reaches the
-- public RPC *before* that insert, so a failure there left the transaction
-- on-chain with no job row — a silent orphan.
--
-- This migration must stay in its own file and contain nothing else.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on
-- PostgreSQL < 12, and a new enum value is not usable by other statements in
-- the same transaction even on 12+. src/store/migrate.ts sends each file as a
-- single implicit transaction, so any statement here that *uses* these values
-- would fail. Keep this file to the two ALTERs.
--
-- No SQL backfill accompanies this. When the insert failed, it failed whole —
-- no row was created, so there is nothing in the database to repair. Orphaned
-- shunts are recoverable only from application logs: shunt.ts logs
-- "Shunt broadcast sent" with the signature *before* the insert runs, so any
-- signature in the logs with no matching jobs.tx_signature is an orphan whose
-- transaction is on-chain but unbilled and invisible to the customer.
-- Failed shunts are unaffected — they insert with status 'failed', which was
-- always a valid enum value, and persisted correctly.

ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'acknowledged';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'shunted';
