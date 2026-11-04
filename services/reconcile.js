'use strict';

/**
 * services/reconcile.js
 * Daily ledger & financial integrity reconciliation service.
 * Verifies mathematical parity across wallets, ledger, tickets, deposits, and withdrawals.
 */

const { pool } = require('../db/pool');

async function runReconciliation() {
  const issues = [];

  // Check 1: Wallet balance equals SUM of ledger amounts
  const { rows: balMismatch } = await pool.query(`
    SELECT
      w.user_id,
      w.currency,
      w.balance AS wallet_balance,
      COALESCE(SUM(l.amount), 0)::bigint AS ledger_sum,
      (w.balance - COALESCE(SUM(l.amount), 0)::bigint) AS discrepancy
    FROM wallets w
    LEFT JOIN ledger_entries l ON l.user_id = w.user_id AND l.currency = w.currency
    GROUP BY w.user_id, w.currency, w.balance
    HAVING w.balance != COALESCE(SUM(l.amount), 0)::bigint
  `);
  if (balMismatch.length > 0) {
    issues.push({
      check: 'wallet_ledger_parity',
      error: `Found ${balMismatch.length} wallets where balance does not equal ledger sum`,
      details: balMismatch,
    });
  }

  // Check 2: No negative wallet balances
  const { rows: negativeWallets } = await pool.query(`
    SELECT user_id, currency, balance
    FROM wallets
    WHERE balance < 0
  `);
  if (negativeWallets.length > 0) {
    issues.push({
      check: 'negative_wallets',
      error: `Found ${negativeWallets.length} wallets with negative balance`,
      details: negativeWallets,
    });
  }

  // Check 3: Every settled won ticket has exactly one credit ledger entry
  const { rows: ticketWinMismatch } = await pool.query(`
    SELECT
      t.id AS ticket_id,
      t.user_id,
      t.payout,
      COUNT(l.id) AS ledger_win_count
    FROM tickets t
    LEFT JOIN ledger_entries l ON l.ref_type = 'ticket' AND l.ref_id = t.id::text AND l.type = 'win'
    WHERE t.status = 'won' AND t.payout > 0
    GROUP BY t.id, t.user_id, t.payout
    HAVING COUNT(l.id) != 1
  `);
  if (ticketWinMismatch.length > 0) {
    issues.push({
      check: 'ticket_win_entries',
      error: `Found ${ticketWinMismatch.length} won tickets without exactly one ledger win entry`,
      details: ticketWinMismatch,
    });
  }

  // Check 4: Every approved deposit has exactly one credit ledger entry
  const { rows: depositMismatch } = await pool.query(`
    SELECT
      d.id AS deposit_id,
      d.user_id,
      d.amount_cents,
      COUNT(l.id) AS ledger_credit_count
    FROM deposit_requests d
    LEFT JOIN ledger_entries l ON l.ref_type = 'deposit_request' AND l.ref_id = d.id::text AND l.type = 'deposit'
    WHERE d.status = 'approved'
    GROUP BY d.id, d.user_id, d.amount_cents
    HAVING COUNT(l.id) != 1
  `);
  if (depositMismatch.length > 0) {
    issues.push({
      check: 'deposit_credit_entries',
      error: `Found ${depositMismatch.length} approved deposits without exactly one ledger credit entry`,
      details: depositMismatch,
    });
  }

  // Check 5: Every rejected withdrawal has a corresponding refund ledger entry
  const { rows: wdrRefundMismatch } = await pool.query(`
    SELECT
      w.id AS withdrawal_id,
      w.user_id,
      w.amount_cents,
      COUNT(l.id) AS ledger_refund_count
    FROM withdrawal_requests w
    LEFT JOIN ledger_entries l ON l.ref_type = 'withdrawal_request' AND l.ref_id = w.id::text AND l.type = 'refund'
    WHERE w.status = 'rejected'
    GROUP BY w.id, w.user_id, w.amount_cents
    HAVING COUNT(l.id) != 1
  `);
  if (wdrRefundMismatch.length > 0) {
    issues.push({
      check: 'withdrawal_refund_entries',
      error: `Found ${wdrRefundMismatch.length} rejected withdrawals without exactly one ledger refund entry`,
      details: wdrRefundMismatch,
    });
  }

  return {
    ok: issues.length === 0,
    timestamp: new Date().toISOString(),
    issueCount: issues.length,
    issues,
  };
}

module.exports = { runReconciliation };
