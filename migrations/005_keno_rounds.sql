-- Migration 005: keno_rounds table
-- Run order: 5

CREATE TABLE IF NOT EXISTS keno_rounds (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  nonce        BIGINT NOT NULL,
  seed_pair_id BIGINT NOT NULL REFERENCES seed_pairs(id) ON DELETE RESTRICT,
  client_seed  TEXT NOT NULL,
  picks        INT[] NOT NULL,
  bet          BIGINT NOT NULL,             -- in cents
  drawn        INT[] NOT NULL,
  hits         INT NOT NULL,
  payout       BIGINT NOT NULL,             -- in cents
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS keno_rounds_user_created
  ON keno_rounds (user_id, created_at DESC);
