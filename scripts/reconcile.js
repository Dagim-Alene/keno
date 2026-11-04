'use strict';

/**
 * scripts/reconcile.js
 * CLI command to run daily ledger reconciliation.
 * Usage: npm run reconcile OR node scripts/reconcile.js
 */

require('dotenv').config();
const { runReconciliation } = require('../services/reconcile');
const { pool } = require('../db/pool');

async function main() {
  console.log('[reconcile] Starting financial parity and ledger audit...');
  const result = await runReconciliation();

  if (result.ok) {
    console.log('[reconcile] ✅ ALL CHECKS PASSED: Full mathematical parity between wallets, ledger, tickets, deposits and withdrawals.');
    await pool.end();
    process.exit(0);
  } else {
    console.error(`[reconcile] ❌ RECONCILIATION FAILED WITH ${result.issueCount} ISSUE(S):`);
    for (const issue of result.issues) {
      console.error(`\n- [${issue.check}] ${issue.error}`);
      console.error(JSON.stringify(issue.details, null, 2));
    }
    await pool.end();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[reconcile] Fatal error:', err);
  process.exit(1);
});
