-- Team-configurable settings surfaced in the console Settings page.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS webhook_url TEXT;

COMMENT ON COLUMN teams.webhook_url IS 'Pro+ tier callback URL for intent status notifications';
