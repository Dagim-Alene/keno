-- Migration 010: deposit_requests table — manual deposit flow
-- Run order: 10

CREATE TABLE IF NOT EXISTS deposit_requests (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents     BIGINT NOT NULL,
  method           TEXT NOT NULL,
  reference_code   TEXT NOT NULL UNIQUE,
  tx_reference     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','expired')),
  ledger_credit_id BIGINT,
  admin_id         TEXT,
  decided_at       TIMESTAMPTZ,
  note             TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deposit_requests_user ON deposit_requests(user_id);
CREATE INDEX IF NOT EXISTS deposit_requests_status ON deposit_requests(status);
