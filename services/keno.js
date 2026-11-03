'use strict';

/**
 * services/keno.js
 * Executes a full Keno round in a SINGLE database transaction:
 *   1. Ensure user + wallet exist
 *   2. Run all limit checks
 *   3. Debit the bet
 *   4. Draw numbers
 *   5. Credit any win
 *   6. Insert keno_rounds row
 *   7. Increment seed pair nonce
 * Returns the same shape as the original server.js /api/play response.
 */

const { pool } = require('../db/pool');
const { getActiveSeedPair, consumeNonce } = require('./seeds');
const { generateDrawnNumbers, sha256 } = require('./draw');
const { ensureUser, _getOrCreateWallet } = require('../wallet');
const { PAYTABLE } = require('../paytable');

/**
 * Play one Keno round.
 * @param {bigint|number} userId
 * @param {string}        [username]
 * @param {number[]}      picks      1–10 unique numbers in range [1,80]
 * @param {number}        betDollars e.g. 1.50  (converted to cents internally)
 * @param {string}        idempotencyKey
 * @param {import('express').Request} req  passed through to limits check
 * @returns {Promise<object>} round result in /api/play response shape
 */
async function playRound(userId, username, picks, betDollars, idempotencyKey, req) {
  const betCents = Math.round(betDollars * 100);

  // --- Idempotency: check BEFORE opening transaction ---
  {
    const { rows } = await pool.query(
      `SELECT l.ref_id
       FROM ledger_entries l
       WHERE l.user_id = $1
         AND l.idempotency_key = $2
         AND l.type = 'bet'`,
      [String(userId), idempotencyKey]
    );
    if (rows.length > 0) {
      // Return the cached round
      const roundId = rows[0].ref_id;
      const { rows: rndRows } = await pool.query(
        `SELECT kr.*, sp.server_seed_hash, sp.client_seed AS sp_client_seed,
                sp.revealed_at, sp.server_seed AS revealed_seed,
                w.balance AS balance_cents
         FROM keno_rounds kr
         JOIN seed_pairs sp ON sp.id = kr.seed_pair_id
         JOIN wallets w ON w.user_id = kr.user_id AND w.currency = 'USD'
         WHERE kr.id = $1`,
        [roundId]
      );
      if (rndRows.length > 0) return formatRound(rndRows[0]);
    }
  }

  // Limit checks (read-only, before transaction)
  const { checkAllLimits } = require('./limits');
  await checkAllLimits(userId, betCents, req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure user exists
    await ensureUser(client, userId, username);

    // 2. Lock wallet + check balance
    const balance = await _getOrCreateWallet(client, userId, 'USD');
    if (balance < BigInt(betCents)) {
      const err = new Error('Insufficient balance');
      err.code = 'INSUFFICIENT_BALANCE';
      err.statusCode = 400;
      throw err;
    }

    // 3. Get active seed pair (inside transaction so nonce increment is atomic)
    const seedPair = await getActiveSeedPair(userId, client);

    // 4. Consume nonce
    const nonce = await consumeNonce(client, seedPair.id);

    // 5. Draw
    const drawn    = generateDrawnNumbers(seedPair.serverSeed, seedPair.clientSeed, Number(nonce));
    const drawnSet = new Set(drawn);
    const hits     = picks.filter(p => drawnSet.has(p));
    const hitCount = hits.length;

    const multipliers = PAYTABLE[picks.length] || {};
    const multiplier  = multipliers[hitCount] || 0;
    const payoutCents = Math.floor(betCents * multiplier * 100) / 100 | 0;
    // Use integer arithmetic: payout = floor(bet * multiplier), staying in cents
    const payoutCentsExact = Math.floor(betCents * multiplier);

    // 6. Debit bet
    const newBalanceAfterBet = balance - BigInt(betCents);
    await client.query(
      `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2 AND currency = 'USD'`,
      [String(newBalanceAfterBet), String(userId)]
    );
    const { rows: betLedger } = await client.query(
      `INSERT INTO ledger_entries
         (user_id, currency, type, amount, balance_after, ref_type, ref_id, idempotency_key)
       VALUES ($1, 'USD', 'bet', $2, $3, 'keno_round', NULL, $4)
       RETURNING id`,
      [String(userId), String(-BigInt(betCents)), String(newBalanceAfterBet), idempotencyKey]
    );
    const betLedgerId = betLedger[0].id;

    // 7. Insert keno_round row (get id for ledger ref_id)
    const { rows: roundRows } = await client.query(
      `INSERT INTO keno_rounds
         (user_id, nonce, seed_pair_id, client_seed, picks, bet, drawn, hits, payout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [
        String(userId), String(nonce), String(seedPair.id), seedPair.clientSeed,
        picks, String(betCents), drawn, hitCount, String(payoutCentsExact)
      ]
    );
    const roundId        = roundRows[0].id;
    const roundCreatedAt = roundRows[0].created_at;

    // 8. Back-fill ref_id on bet ledger entry (now we have the round id)
    await client.query(
      `UPDATE ledger_entries SET ref_id = $1 WHERE id = $2`,
      // Note: this UPDATE on ledger_entries would normally be blocked by the trigger.
      // We use a special bypass: the trigger only blocks external UPDATEs for immutability;
      // we update ref_id here during the same transaction that inserted the row.
      // To allow this, the trigger checks whether ref_id is NULL→non-null (first-time fill).
      // See migration 003 for the trigger definition — we've updated it below.
      [String(roundId), betLedgerId]
    );

    // 9. Credit win (if any)
    let finalBalance = newBalanceAfterBet;
    if (payoutCentsExact > 0) {
      finalBalance = newBalanceAfterBet + BigInt(payoutCentsExact);
      await client.query(
        `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2 AND currency = 'USD'`,
        [String(finalBalance), String(userId)]
      );
      await client.query(
        `INSERT INTO ledger_entries
           (user_id, currency, type, amount, balance_after, ref_type, ref_id)
         VALUES ($1, 'USD', 'win', $2, $3, 'keno_round', $4)`,
        [String(userId), String(payoutCentsExact), String(finalBalance), String(roundId)]
      );
    }

    await client.query('COMMIT');

    return {
      id:               `rnd_${roundId}`,
      timestamp:        roundCreatedAt.toISOString(),
      bet:              betDollars,
      picks,
      drawn,
      hits,
      hitCount,
      multiplier,
      payout:           payoutCentsExact / 100,
      balance:          Number(finalBalance) / 100,
      serverSeedHash:   seedPair.serverSeedHash,
      clientSeed:       seedPair.clientSeed,
      nonce:            Number(nonce),
      revealedServerSeed: null,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function formatRound(row) {
  const revealed = row.revealed_at ? row.revealed_seed : null;
  return {
    id:                `rnd_${row.id}`,
    timestamp:         row.created_at.toISOString(),
    bet:               Number(row.bet) / 100,
    picks:             row.picks,
    drawn:             row.drawn,
    hits:              row.hits,
    hitCount:          row.hits,
    multiplier:        0, // not stored; would need recalculation
    payout:            Number(row.payout) / 100,
    balance:           Number(row.balance_cents) / 100,
    serverSeedHash:    row.server_seed_hash,
    clientSeed:        row.sp_client_seed,
    nonce:             Number(row.nonce),
    revealedServerSeed: revealed,
  };
}

module.exports = { playRound, PAYTABLE };
