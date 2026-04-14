CREATE OR REPLACE FUNCTION increment_job_retry(p_job_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE jobs SET retry_count = retry_count + 1, updated_at = now() WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

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
    'total', COUNT(*)::text
  ) INTO counts
  FROM jobs;

  SELECT json_build_object(
    'fees_collected_usdc', COALESCE(SUM(intent_fee::numeric) FILTER (WHERE status = 'confirmed' AND intent_fee IS NOT NULL), 0)::text,
    'transfer_total_usdc', COALESCE(SUM(intent_total::numeric) FILTER (WHERE status = 'confirmed' AND intent_total IS NOT NULL), 0)::text,
    'avg_confirmed_fee_usdc', COALESCE(AVG(intent_fee::numeric) FILTER (WHERE status = 'confirmed' AND intent_fee IS NOT NULL), 0)::text
  ) INTO economics
  FROM jobs;

  RETURN json_build_object('counts', counts, 'economics', economics);
END;
$$ LANGUAGE plpgsql;
