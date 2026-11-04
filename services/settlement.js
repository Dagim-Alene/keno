'use strict';

/**
 * services/settlement.js
 * Idempotent ticket settlement for a live round.
 * Safe to run multiple times — no double credits.
 */

const { pool, withTransaction } = require('../db/pool');
const { credit } = require('../wallet');
const { PAYTABLE } = require('../paytable');

const DEFAULT_MAX_TICKET = 1_000_000;   // 10,000 ETB
const DEFAULT_MAX_ROUND  = 5_000_000;   // 50,000 ETB

/**
 * Load payout caps from game_config table (or use defaults).
 * @param {import('pg').PoolClient} client
 */
async function loadCaps(client) {
  const { rows } = await client.query(
    `SELECT key, value FROM game_config
     WHERE key IN ('max_payout_per_ticket_cents','max_total_payout_per_round_cents')`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, Number(r.value)]));
  return {
    maxPerTicket : cfg.max_payout_per_ticket_cents  || DEFAULT_MAX_TICKET,
    maxPerRound  : cfg.max_total_payout_per_round_cents || DEFAULT_MAX_ROUND,
  };
}

/**
 * Settle all unsettled tickets for a live round.
 * Reveals the server seed and marks the round settled.
 *
 * @param {bigint|number} roundId
 * @param {number[]}      drawn     — 20 drawn numbers
 * @param {string}        serverSeed — the actual secret seed for this round
 * @returns {Promise<{ settledCount: number, totalPayout: bigint }>}
 */
async function settleRound(roundId, drawn, serverSeed) {
  const rid = String(roundId);
  const drawnSet = new Set(drawn);

  // Load unsettled tickets
  const { rows: tickets } = await pool.query(
    `SELECT * FROM tickets WHERE round_id = $1 AND settled_at IS NULL ORDER BY id ASC`,
    [rid]
  );

  let settledCount = 0;
  let totalPayout = 0n;

  // Compute running total of payouts already in this round (from already-settled tickets)
  const { rows: capRows } = await pool.query(
    `SELECT COALESCE(SUM(payout), 0)::bigint AS paid
     FROM tickets WHERE round_id = $1 AND status = 'won'`,
    [rid]
  );
  let roundPayoutSoFar = BigInt(capRows[0].paid);

  // Load caps inside a quick transaction
  const client = await pool.connect();
  let caps;
  try {
    caps = await loadCaps(client);
  } finally {
    client.release();
  }

  for (const ticket of tickets) {
    const hits   = ticket.picks.filter(p => drawnSet.has(p)).length;
    const tbl    = PAYTABLE[ticket.picks.length] || {};
    const mult   = tbl[hits] || 0;
    const rawPay = BigInt(Math.floor(Number(ticket.bet) * mult));
    const payout = rawPay > BigInt(caps.maxPerTicket) ? BigInt(caps.maxPerTicket) : rawPay;

    // Respect round cap
    const cappedPayout = (roundPayoutSoFar + payout > BigInt(caps.maxPerRound))
      ? BigInt(caps.maxPerRound) - roundPayoutSoFar
      : payout;
    const finalPayout = cappedPayout < 0n ? 0n : cappedPayout;

    const won    = finalPayout > 0n;
    const status = won ? 'won' : 'lost';

    await withTransaction(async (cl) => {
      // Check idempotency: if already settled, skip
      const { rows: check } = await cl.query(
        `SELECT id FROM tickets WHERE id = $1 AND settled_at IS NOT NULL`,
        [String(ticket.id)]
      );
      if (check.length > 0) return;

      let ledgerWinId = null;
      if (won) {
        const ikey = `ticket_win_${ticket.id}`;
        const { ledgerId } = await credit(
          ticket.user_id, 'ETB', finalPayout,
          'win', 'ticket', String(ticket.id),
          ikey, cl
        );
        ledgerWinId = ledgerId;
      }

      await cl.query(
        `UPDATE tickets
         SET status = $1, payout = $2, ledger_win_id = $3, settled_at = NOW()
         WHERE id = $4 AND settled_at IS NULL`,
        [status, String(finalPayout), ledgerWinId ? String(ledgerWinId) : null, String(ticket.id)]
      );
    });

    if (won) {
      roundPayoutSoFar += finalPayout;
      totalPayout += finalPayout;
    }
    settledCount++;
  }

  // Void any still-open tickets (shouldn't happen, but safety net)
  await pool.query(
    `UPDATE tickets SET status = 'void', settled_at = NOW()
     WHERE round_id = $1 AND settled_at IS NULL`,
    [rid]
  );

  // Reveal server seed and mark round settled
  await pool.query(
    `UPDATE live_rounds
     SET status = 'settled', server_seed = $1, settled_at = NOW()
     WHERE id = $2 AND settled_at IS NULL`,
    [serverSeed, rid]
  );

  return { settledCount, totalPayout };
}

/**
 * Void all tickets in a round (refund each bet via ledger).
 * Used when crash recovery cannot safely determine the draw.
 * @param {bigint|number} roundId
 */
async function voidRound(roundId) {
  const rid = String(roundId);
  const { rows: tickets } = await pool.query(
    `SELECT * FROM tickets WHERE round_id = $1 AND status = 'open'`,
    [rid]
  );

  for (const ticket of tickets) {
    await withTransaction(async (cl) => {
      const ikey = `refund_void_ticket_${ticket.id}`;
      const { rows: check } = await cl.query(
        `SELECT 1 FROM ledger_entries WHERE idempotency_key = $1`, [ikey]
      );
      if (check.length > 0) return;

      await credit(
        ticket.user_id, 'ETB', ticket.bet,
        'refund', 'ticket', String(ticket.id),
        ikey, cl
      );
      await cl.query(
        `UPDATE tickets SET status = 'refunded', payout = 0, settled_at = NOW()
         WHERE id = $1 AND status = 'open'`,
        [String(ticket.id)]
      );
    });
  }

  await pool.query(
    `UPDATE live_rounds SET status = 'void', settled_at = NOW()
     WHERE id = $1`,
    [rid]
  );
}

module.exports = { settleRound, voidRound, loadCaps };
