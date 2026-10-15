-- Additive schema migration for ZAVAEBATEL UC.
-- Review and back up the target database before applying. No order rows or statuses are rewritten.
BEGIN;

CREATE TABLE IF NOT EXISTS user_sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS IDX_user_sessions_expire ON user_sessions(expire);

CREATE TABLE IF NOT EXISTS manual_orders (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE,
  access_secret_hash TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  player_id TEXT NOT NULL,
  amount_rub NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  receipt_data BYTEA,
  receipt_mime TEXT,
  receipt_uploaded_at TIMESTAMPTZ,
  admin_note TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE manual_orders ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
CREATE INDEX IF NOT EXISTS manual_orders_created_at_idx ON manual_orders(created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit (
  id BIGSERIAL PRIMARY KEY,
  order_public_id UUID NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  admin_identity TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
