ALTER TABLE jobs ADD COLUMN IF NOT EXISTS intent_sender TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS intent_nonce TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS intent_type TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_intent_sender_nonce
  ON jobs (intent_sender, intent_nonce);
