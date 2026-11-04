-- Migration 008: live_rounds table for shared real-time Keno rounds
-- Run order: 8

CREATE TABLE IF NOT EXISTS live_rounds (
  id               BIGSERIAL PRIMARY KEY,
  round_number     BIGINT UNIQUE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'betting'
                     CHECK (status IN ('betting','locked','drawing','result','settled','void')),
  server_seed      TEXT,                     -- NULL until revealed at settlement
  server_seed_hash TEXT NOT NULL,
  prev_round_hash  TEXT,                     -- sha256(prev round's server_seed) for hash chain
  drawn            INT[],                    -- NULL until drawing phase
  betting_opens_at  TIMESTAMPTZ NOT NULL,
  betting_closes_at TIMESTAMPTZ NOT NULL,
  draw_starts_at    TIMESTAMPTZ NOT NULL,
  result_starts_at  TIMESTAMPTZ NOT NULL,
  settled_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS live_rounds_status ON live_rounds(status);
CREATE INDEX IF NOT EXISTS live_rounds_round_number ON live_rounds(round_number DESC);
