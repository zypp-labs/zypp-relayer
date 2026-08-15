-- Group ops metrics economics by currency instead of summing every mint under
-- a `_usdc` label.
--
-- 004_supabase_rpcs.sql summed `intent_fee` and `intent_total` across all rows
-- and named the results `fees_collected_usdc` / `transfer_total_usdc`. Those
-- columns are mint-agnostic — `intent_currency` records which asset each row is
-- denominated in, and nothing consulted it. With one supported token the label
-- was merely redundant. With open token support it is wrong in two ways at
-- once:
--
--   1. The label asserts USDC for figures that may contain any mint.
--   2. Base units are not commensurable across mints. Adding a 6-decimal USDC
--      amount to a 9-decimal SOL amount produces a number denominated in
--      nothing, and the more tokens flow the more meaningless it becomes.
--
-- The replacement returns a per-currency breakdown, so each figure is summed
-- only against others in the same unit. `by_currency` is an object keyed by the
-- mint (or symbol, for legacy rows that stored "USDC"), because a caller cannot
-- interpret a total without knowing what it is denominated in.
--
-- Rows with a NULL `intent_currency` are grouped under 'unknown' rather than
-- dropped: silently omitting value from a financial aggregate is worse than
-- reporting it as unattributed.

CREATE OR REPLACE FUNCTION get_ops_metrics()
RETURNS json AS $$
DECLARE
  counts json;
  economics json;
BEGIN
  SELECT json_build_object(
    'queued', COUNT(*) FILTER (WHERE status = 'queued')::text,
    'sent', COUNT(*) FILTER (WHERE status = 'sent')::text,
    'confirmed', COUNT(*) FILTER (WHERE status = 'confirmed')::text,
    'failed', COUNT(*) FILTER (WHERE status = 'failed')::text,
    'acknowledged', COUNT(*) FILTER (WHERE status = 'acknowledged')::text,
    'shunted', COUNT(*) FILTER (WHERE status = 'shunted')::text,
    'total', COUNT(*)::text
  ) INTO counts
  FROM jobs;

  SELECT COALESCE(
    json_object_agg(currency, totals),
    '{}'::json
  ) INTO economics
  FROM (
    SELECT
      COALESCE(intent_currency, 'unknown') AS currency,
      json_build_object(
        'fees_collected', COALESCE(SUM(intent_fee::numeric) FILTER (WHERE intent_fee IS NOT NULL), 0)::text,
        'transfer_total', COALESCE(SUM(intent_total::numeric) FILTER (WHERE intent_total IS NOT NULL), 0)::text,
        'avg_fee', COALESCE(AVG(intent_fee::numeric) FILTER (WHERE intent_fee IS NOT NULL), 0)::text,
        'confirmed_count', COUNT(*)::text
      ) AS totals
    FROM jobs
    WHERE status = 'confirmed'
    GROUP BY COALESCE(intent_currency, 'unknown')
  ) per_currency;

  RETURN json_build_object('counts', counts, 'by_currency', economics);
END;
$$ LANGUAGE plpgsql;
