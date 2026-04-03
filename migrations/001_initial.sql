-- ZRN jobs: one row per submitted transaction
DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('queued', 'sent', 'confirmed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status job_status NOT NULL DEFAULT 'queued',
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  tx_signature TEXT,
  payload_hash TEXT NOT NULL,
  payload BYTEA NOT NULL,
  rpc_endpoint_used TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_payload_hash_recent ON jobs (payload_hash)
  WHERE status IN ('queued', 'sent');

COMMENT ON TABLE jobs IS 'ZRN relay jobs; payload is the raw serialized signed transaction';

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  from_status job_status,
  to_status job_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_job_id ON audit_log (job_id);
