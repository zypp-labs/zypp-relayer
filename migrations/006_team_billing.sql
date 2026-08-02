-- Teams table for per-team billing and plan management
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  polar_customer_id TEXT UNIQUE,
  polar_subscription_id TEXT,
  credits_limit INTEGER NOT NULL DEFAULT 100,
  credits_remaining INTEGER NOT NULL DEFAULT 100,
  credits_reset_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users table (wallet-linked team members)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  wallet_address TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys table (per-team keys for relayer auth)
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add team_id to jobs table for per-team billing
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT false;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_wallet ON users (wallet_address);
CREATE INDEX IF NOT EXISTS idx_api_keys_team ON api_keys (team_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_team ON jobs (team_id);

-- Comments
COMMENT ON TABLE teams IS 'Developer teams with billing plans and credit allocation';
COMMENT ON TABLE users IS 'Team members identified by Solana wallet address';
COMMENT ON TABLE api_keys IS 'Per-team API keys for relayer authentication';
COMMENT ON COLUMN jobs.team_id IS 'Team that owns this intent (for billing)';
COMMENT ON COLUMN jobs.degraded IS 'True if processed via Standard RPC Shunt (degraded path)';

-- RPC: atomically deduct one credit if available, return false if exhausted
CREATE OR REPLACE FUNCTION deduct_team_credit(p_team_id UUID)
RETURNS boolean AS $$
DECLARE
  v_remaining INTEGER;
BEGIN
  SELECT credits_remaining INTO v_remaining FROM teams WHERE id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_remaining <= 0 THEN RETURN false; END IF;
  UPDATE teams SET credits_remaining = credits_remaining - 1, updated_at = now() WHERE id = p_team_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- RPC: atomically check + deduct, returns (has_credit bool, degraded bool)
-- This eliminates the read-before-write race in the relayer ingress.
-- If credits remain, deducts 1 and returns has_credit=true, degraded=false.
-- If exhausted, returns has_credit=false, degraded=true (no mutation).
CREATE OR REPLACE FUNCTION try_consume_credit(p_team_id UUID)
RETURNS json AS $$
DECLARE
  v_remaining INTEGER;
BEGIN
  SELECT credits_remaining INTO v_remaining FROM teams WHERE id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('has_credit', false, 'degraded', true);
  END IF;
  IF v_remaining <= 0 THEN
    RETURN json_build_object('has_credit', false, 'degraded', true);
  END IF;
  UPDATE teams SET credits_remaining = credits_remaining - 1, updated_at = now() WHERE id = p_team_id;
  RETURN json_build_object('has_credit', true, 'degraded', false);
END;
$$ LANGUAGE plpgsql;

-- RPC: atomically create a team and user for a new wallet address
-- Eliminates the orphan-row race in the console verify endpoint.
CREATE OR REPLACE FUNCTION create_team_for_wallet(p_wallet TEXT)
RETURNS json AS $$
DECLARE
  v_team_id UUID;
  v_slug TEXT;
  v_existing_id UUID;
BEGIN
  -- Guard: wallet already registered
  SELECT team_id INTO v_existing_id FROM users WHERE wallet_address = p_wallet;
  IF FOUND THEN
    RETURN json_build_object('team_id', v_existing_id, 'slug', null, 'existing', true);
  END IF;

  v_slug := 'team-' || lower(left(p_wallet, 8)) || '-' || left(gen_random_uuid()::text, 8);

  INSERT INTO teams (name, slug, credits_limit, credits_remaining)
  VALUES ('My Team', v_slug, 100, 100)
  RETURNING id INTO v_team_id;

  INSERT INTO users (team_id, wallet_address)
  VALUES (v_team_id, p_wallet);

  RETURN json_build_object('team_id', v_team_id, 'slug', v_slug, 'existing', false);
END;
$$ LANGUAGE plpgsql;

-- RPC: reset all teams' credits to their limit (called by cron monthly)
CREATE OR REPLACE FUNCTION reset_team_credits()
RETURNS void AS $$
BEGIN
  UPDATE teams
  SET credits_remaining = credits_limit, credits_reset_at = now(), updated_at = now();
END;
$$ LANGUAGE plpgsql;
