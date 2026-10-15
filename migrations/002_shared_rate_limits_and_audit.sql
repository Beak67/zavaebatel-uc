-- Shared PostgreSQL rate limits and structured admin audit metadata.
-- Idempotent additive migration. Apply only after backup and test on an isolated database.
BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  limiter_name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  hits INTEGER NOT NULL CHECK (hits >= 0),
  reset_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (limiter_name, key_hash)
);
CREATE INDEX IF NOT EXISTS rate_limit_counters_reset_at_idx ON rate_limit_counters(reset_at);

-- Ensure an audit table exists even if the earlier base migration was only partially applied.
CREATE TABLE IF NOT EXISTS admin_audit (
  id BIGSERIAL PRIMARY KEY,
  order_public_id UUID,
  action TEXT NOT NULL DEFAULT 'legacy_event',
  result TEXT NOT NULL DEFAULT 'unknown',
  admin_identity TEXT NOT NULL DEFAULT 'anonymous',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS order_public_id UUID;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'legacy_event';
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS admin_identity TEXT NOT NULL DEFAULT 'anonymous';
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS operation_type TEXT;
UPDATE admin_audit SET operation_type = action WHERE operation_type IS NULL;
ALTER TABLE admin_audit ALTER COLUMN operation_type SET NOT NULL;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_id TEXT;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS session_hash TEXT;
ALTER TABLE admin_audit ALTER COLUMN order_public_id DROP NOT NULL;

COMMIT;
