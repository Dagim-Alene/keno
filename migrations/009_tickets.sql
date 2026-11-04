-- Migration 009: tickets table — player bets per live round
-- Run order: 9

CREATE TABLE IF NOT EXISTS tickets (
  id               BIGSERIAL PRIMARY KEY,
  round_id         BIGINT NOT NULL REFERENCES live_rounds(id) ON DELETE RESTRICT,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  picks            INT[] NOT NULL,
  bet              BIGINT NOT NULL,          -- cents
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','won','lost','void','refunded')),
  payout           BIGINT,                   -- cents, NULL until settled
  ledger_bet_id    BIGINT,
  ledger_win_id    BIGINT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tickets_round_user ON tickets(round_id, user_id);
CREATE INDEX IF NOT EXISTS tickets_user_created ON tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_round_unsettled ON tickets(round_id) WHERE settled_at IS NULL;
