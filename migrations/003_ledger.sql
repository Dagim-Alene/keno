-- Migration 003: ledger_entries table (append-only)
-- Run order: 3

CREATE TABLE IF NOT EXISTS ledger_entries (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency         TEXT NOT NULL DEFAULT 'USD',
  type             TEXT NOT NULL
                     CHECK (type IN ('deposit','withdrawal','bet','win','refund','adjustment')),
  amount           BIGINT NOT NULL,          -- signed: negative = debit, positive = credit
  balance_after    BIGINT NOT NULL,          -- wallet balance after this entry
  ref_type         TEXT,                     -- e.g. 'keno_round', 'payment', 'withdrawal_request'
  ref_id           TEXT,                     -- FK value in the referenced table (as text)
  idempotency_key  TEXT UNIQUE,              -- prevents double-charges
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ledger_entries_user_created
  ON ledger_entries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ledger_entries_idempotency
  ON ledger_entries (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Append-only enforcement: block UPDATE and DELETE.
-- Exception: allow the first-time fill of ref_id (NULL → non-null) so that
-- keno.js can back-fill the round id on the bet ledger entry within the same
-- transaction. All other column changes are still blocked.
CREATE OR REPLACE FUNCTION ledger_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Allow ref_id to be set once (NULL -> value), block everything else
  IF OLD.ref_id IS NULL AND NEW.ref_id IS NOT NULL
    AND OLD.id             = NEW.id
    AND OLD.user_id        = NEW.user_id
    AND OLD.currency       = NEW.currency
    AND OLD.type           = NEW.type
    AND OLD.amount         = NEW.amount
    AND OLD.balance_after  = NEW.balance_after
    AND (OLD.ref_type      IS NOT DISTINCT FROM NEW.ref_type)
    AND (OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key)
    AND OLD.created_at     = NEW.created_at
  THEN
    RETURN NEW;  -- Allow this one specific update
  END IF;
  RAISE EXCEPTION 'ledger_entries is append-only: only initial ref_id fill is permitted';
END;
$$;

DROP TRIGGER IF EXISTS ledger_no_update ON ledger_entries;
CREATE TRIGGER ledger_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

DROP TRIGGER IF EXISTS ledger_no_delete ON ledger_entries;
CREATE TRIGGER ledger_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
