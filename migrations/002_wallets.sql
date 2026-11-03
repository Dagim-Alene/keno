-- Migration 002: wallets table
-- Run order: 2

CREATE TABLE IF NOT EXISTS wallets (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency    TEXT NOT NULL DEFAULT 'USD',
  balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, currency)
);
