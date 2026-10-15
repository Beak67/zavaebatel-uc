-- Shared PostgreSQL rate limits and structured admin audit metadata.
-- Additive and idempotent; apply only to an isolated/test database during this audit.
BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  limiter_name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  hits INTEGER NOT NULL CHECK (hits >= 0),
  reset_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (limiter_name, key_hash)
);
CREATE INDEX IF NOT EXISTS rate_limit_counters_reset_at_idx ON rate_limit_counters(reset_at);

-- Older schema required an order UUID, which cannot represent login/origin/auth events.
ALTER TABLE admin_audit ALTER COLUMN order_public_id DROP NOT NULL;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_id TEXT;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS session_hash TEXT;

COMMIT;
