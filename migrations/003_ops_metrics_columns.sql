ALTER TABLE jobs ADD COLUMN IF NOT EXISTS intent_fee NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS intent_total NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS intent_currency TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_intent_type_status
  ON jobs (intent_type, status);
