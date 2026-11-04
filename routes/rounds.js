'use strict';

/**
 * routes/rounds.js
 * GET /api/rounds/recent — list recent settled rounds for history & verification
 * GET /api/rounds/:roundNumber — detail of a specific round
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');

router.get('/recent', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const { rows } = await pool.query(
      `SELECT id, round_number, status, drawn, server_seed, server_seed_hash, prev_round_hash, settled_at
       FROM live_rounds
       WHERE status = 'settled'
       ORDER BY round_number DESC
       LIMIT $1`,
      [limit]
    );

    res.json(rows.map(r => ({
      id: String(r.id),
      roundNumber: Number(r.round_number),
      status: r.status,
      drawn: r.drawn,
      serverSeed: r.server_seed,
      serverSeedHash: r.server_seed_hash,
      prevRoundHash: r.prev_round_hash,
      settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    })));
  } catch (err) {
    console.error('[GET /api/rounds/recent]', err);
    res.status(500).json({ error: 'Failed to fetch recent rounds' });
  }
});

router.get('/:roundNumber', async (req, res) => {
  try {
    const roundNumber = Number(req.params.roundNumber);
    if (isNaN(roundNumber)) {
      return res.status(400).json({ error: 'Invalid round number' });
    }

    const { rows } = await pool.query(
      `SELECT id, round_number, status, drawn, server_seed, server_seed_hash, prev_round_hash, settled_at
       FROM live_rounds
       WHERE round_number = $1`,
      [roundNumber]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Round not found' });
    }

    const r = rows[0];
    res.json({
      id: String(r.id),
      roundNumber: Number(r.round_number),
      status: r.status,
      drawn: (r.status === 'settled') ? r.drawn : null,
      serverSeed: (r.status === 'settled') ? r.server_seed : null,
      serverSeedHash: r.server_seed_hash,
      prevRoundHash: r.prev_round_hash,
      settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    });
  } catch (err) {
    console.error('[GET /api/rounds/:roundNumber]', err);
    res.status(500).json({ error: 'Failed to fetch round details' });
  }
});

module.exports = router;
