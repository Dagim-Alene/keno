-- Migration 004: seed_pairs table
-- Run order: 4

CREATE TABLE IF NOT EXISTS seed_pairs (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  server_seed      TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed      TEXT NOT NULL,
  next_nonce       BIGINT NOT NULL DEFAULT 0,
  revealed_at      TIMESTAMPTZ,             -- NULL = currently active; set on rotation
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS seed_pairs_user_active
  ON seed_pairs (user_id)
  WHERE revealed_at IS NULL;
