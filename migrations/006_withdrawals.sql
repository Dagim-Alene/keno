-- Migration 006: withdrawal_requests table (for the payments skeleton)
-- Run order: 6

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency     TEXT NOT NULL DEFAULT 'USD',
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  ledger_debit_id  BIGINT REFERENCES ledger_entries(id),   -- the debit entry
  ledger_refund_id BIGINT REFERENCES ledger_entries(id),   -- set on rejection
  admin_note   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS withdrawal_requests_user
  ON withdrawal_requests (user_id, created_at DESC);
