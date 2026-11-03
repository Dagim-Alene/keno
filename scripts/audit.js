#!/usr/bin/env node
'use strict';

/**
 * scripts/audit.js
 * Checks that the sum of ledger entries per wallet equals its current balance.
 * Reports any mismatches. Exit code 1 if any mismatch found.
 *
 * Usage: npm run audit
 */

require('dotenv').config();
const { pool } = require('../db/pool');

async function audit() {
  console.log('[audit] Checking ledger integrity...');

  const { rows } = await pool.query(`
    SELECT
      w.user_id,
      w.currency,
      w.balance                              AS wallet_balance,
      COALESCE(SUM(l.amount), 0)::bigint     AS ledger_sum,
      COUNT(l.id)                            AS entry_count
    FROM wallets w
    LEFT JOIN ledger_entries l
      ON l.user_id = w.user_id AND l.currency = w.currency
    GROUP BY w.user_id, w.currency, w.balance
    ORDER BY w.user_id
  `);

  let mismatches = 0;

  for (const row of rows) {
    const walletBal = BigInt(row.wallet_balance);
    const ledgerSum = BigInt(row.ledger_sum);

    // The ledger sum from zero starts at 0 (no initial deposit entry in dev).
    // If the wallet was seeded with INITIAL_BALANCE_CENTS we also need to account
    // for an implicit initial credit. We compare against a baseline of 0 + sum.
    if (walletBal !== ledgerSum) {
      console.error(
        `MISMATCH user=${row.user_id} ${row.currency}: ` +
        `wallet=${walletBal} ledger_sum=${ledgerSum} ` +
        `(diff=${walletBal - ledgerSum}) entries=${row.entry_count}`
      );
      mismatches++;
    } else {
      console.log(
        `OK  user=${row.user_id} ${row.currency}: ` +
        `balance=${walletBal} entries=${row.entry_count}`
      );
    }
  }

  if (mismatches > 0) {
    console.error(`\n[audit] ✗ ${mismatches} mismatch(es) found.`);
  } else {
    console.log(`\n[audit] ✓ All ${rows.length} wallet(s) are consistent.`);
  }

  await pool.end();
  process.exit(mismatches > 0 ? 1 : 0);
}

audit().catch(err => {
  console.error('[audit] Fatal:', err.message);
  process.exit(1);
});
