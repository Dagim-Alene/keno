'use strict';

/**
 * routes/state.js
 * GET /api/state  — balance, seeds, paytable, limits
 * GET /api/history — recent rounds for this session user
 */

const express = require('express');
const router  = express.Router();
const { pool } = require('../db/pool');
const { getActiveSeedPair } = require('../services/seeds');
const { PAYTABLE } = require('../services/keno');
const { ensureUser, _getOrCreateWallet } = require('../wallet');

const MIN_BET_CENTS = Number(process.env.MIN_BET_CENTS || 100);
const MAX_BET_CENTS = Number(process.env.MAX_BET_CENTS || 10_000);

// Middleware: resolve Telegram user from initData or dev header
// (Full Telegram initData validation is in middleware/telegram.js and applied in server.js)
// Here we just expect req.userId to already be set.

router.get('/state', async (req, res) => {
  try {
    const userId = req.userId;

    // Ensure user + wallet exist (idempotent)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ensureUser(client, userId, req.telegramUsername);
      await _getOrCreateWallet(client, userId, 'ETB');
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Fetch balance
    const { rows: balRows } = await pool.query(
      `SELECT balance FROM wallets WHERE user_id = $1 AND currency = 'ETB'`,
      [String(userId)]
    );
    const balanceCents = balRows.length ? Number(balRows[0].balance) : 0;

    // Fetch active seed pair (creates one if missing)
    const seedPair = await getActiveSeedPair(userId);

    res.json({
      userId:             String(userId),
      balance:            balanceCents / 100,
      minBet:             MIN_BET_CENTS / 100,
      maxBet:             MAX_BET_CENTS / 100,
      serverSeedHash:     seedPair.serverSeedHash,
      previousServerSeed: null, // revealed seed is only on rotate response
      clientSeed:         seedPair.clientSeed,
      nonce:              Number(seedPair.nonce),
      paytable:           PAYTABLE,
    });
  } catch (err) {
    console.error('[GET /api/state]', err);
    res.status(500).json({ error: 'Failed to load state. Please try again.' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const userId = req.userId;

    // Only return rounds where the seed pair has been rotated (revealed_at IS NOT NULL)
    // to expose the server seed, or omit it for active-pair rounds.
    const { rows } = await pool.query(
      `SELECT
         kr.id, kr.nonce, kr.picks, kr.drawn, kr.hits, kr.bet, kr.payout,
         kr.client_seed, kr.created_at,
         sp.server_seed_hash,
         CASE WHEN sp.revealed_at IS NOT NULL THEN sp.server_seed ELSE NULL END AS revealed_server_seed
       FROM keno_rounds kr
       JOIN seed_pairs sp ON sp.id = kr.seed_pair_id
       WHERE kr.user_id = $1
       ORDER BY kr.created_at DESC
       LIMIT 50`,
      [String(userId)]
    );

    const history = rows.map(r => ({
      id:                 `rnd_${r.id}`,
      timestamp:          r.created_at.toISOString(),
      nonce:              Number(r.nonce),
      picks:              r.picks,
      drawn:              r.drawn,
      hits:               r.hits,
      hitCount:           r.hits,
      bet:                Number(r.bet) / 100,
      payout:             Number(r.payout) / 100,
      clientSeed:         r.client_seed,
      serverSeedHash:     r.server_seed_hash,
      revealedServerSeed: r.revealed_server_seed || null,
    }));

    res.json(history);
  } catch (err) {
    console.error('[GET /api/history]', err);
    res.status(500).json({ error: 'Failed to load history. Please try again.' });
  }
});

module.exports = router;
