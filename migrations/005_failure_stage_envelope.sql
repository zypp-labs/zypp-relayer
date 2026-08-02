ALTER TABLE jobs ADD COLUMN IF NOT EXISTS failure_stage TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS failure_code TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS intent_envelope JSONB;

CREATE INDEX IF NOT EXISTS idx_jobs_failure_stage ON jobs (failure_stage);

COMMENT ON COLUMN jobs.failure_stage IS 'Structured failure stage (Validation, SignatureCheck, IntentMismatch, Broadcast, etc.)';
COMMENT ON COLUMN jobs.failure_code IS 'Machine-readable failure code';
COMMENT ON COLUMN jobs.intent_envelope IS 'Full v1 JSON envelope for intent-based jobs';
