-- Migration 007: Add account_method and account_number to withdrawal_requests
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS account_method TEXT,
  ADD COLUMN IF NOT EXISTS account_number TEXT;
