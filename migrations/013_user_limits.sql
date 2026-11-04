-- Migration 013: Add daily_loss_limit_cents and max_bet_cents to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS daily_loss_limit_cents BIGINT,
  ADD COLUMN IF NOT EXISTS max_bet_cents BIGINT;
