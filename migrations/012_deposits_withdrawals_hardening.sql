-- Migration 012: Manual deposits and withdrawals enhancements
-- 1. Unique constraint on (method, tx_reference) for non-null tx_reference
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_requests_method_tx_ref 
  ON deposit_requests(method, tx_reference) 
  WHERE tx_reference IS NOT NULL AND tx_reference != '';

-- 2. Add claimed_amount_cents and received_amount_cents to deposit_requests
ALTER TABLE deposit_requests
  ADD COLUMN IF NOT EXISTS claimed_amount_cents BIGINT,
  ADD COLUMN IF NOT EXISTS received_amount_cents BIGINT;

-- Backfill claimed_amount_cents with amount_cents
UPDATE deposit_requests 
  SET claimed_amount_cents = amount_cents 
  WHERE claimed_amount_cents IS NULL;

-- 3. Track payout destination updates on users for 24-hour cooling-off
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS payout_destination_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payout_destination TEXT;

-- 4. Multi-admin approval columns on withdrawal_requests
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS first_approved_by TEXT,
  ADD COLUMN IF NOT EXISTS first_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS second_approved_by TEXT,
  ADD COLUMN IF NOT EXISTS second_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requires_second_approval BOOLEAN DEFAULT FALSE;
