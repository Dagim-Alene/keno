-- Migration 001: users table
-- Run order: 1

CREATE TABLE IF NOT EXISTS users (
  id          BIGINT PRIMARY KEY,           -- Telegram user ID
  username    TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'self_excluded', 'suspended')),
  country     TEXT,                          -- ISO 3166-1 alpha-2, e.g. 'US'
  date_of_birth DATE,
  excluded_until TIMESTAMPTZ,               -- set when self_excluded
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
