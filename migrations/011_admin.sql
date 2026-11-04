-- Migration 011: admin tables — audit log and game config
-- Run order: 11

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created ON admin_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS game_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO game_config (key, value) VALUES
  ('game_paused',                      'false'),
  ('max_payout_per_ticket_cents',      '1000000'),
  ('max_total_payout_per_round_cents', '5000000'),
  ('max_tickets_per_round',            '3'),
  ('betting_duration_s',               '25'),
  ('locked_duration_s',                '3'),
  ('drawing_duration_s',               '10'),
  ('result_duration_s',                '5')
ON CONFLICT (key) DO NOTHING;
