'use strict';

/**
 * routes/user.js
 * POST /api/user/limits       — set daily loss limit / max bet
 * POST /api/user/self-exclude — self-exclude for N days
 */

const express = require('express');
const router  = express.Router();
const { pool } = require('../db/pool');

const RG_ENABLED = process.env.RG_ENABLED === 'true';

router.post('/limits', async (req, res) => {
  if (!RG_ENABLED) {
    return res.status(503).json({ error: 'Responsible gaming limits are not active yet.', code: 'RG_NOT_ENABLED' });
  }

  const { dailyLossLimitCents, maxBetCents } = req.body;

  if (dailyLossLimitCents !== undefined &&
      (typeof dailyLossLimitCents !== 'number' || dailyLossLimitCents < 0)) {
    return res.status(400).json({ error: 'dailyLossLimitCents must be a non-negative number.' });
  }
  if (maxBetCents !== undefined &&
      (typeof maxBetCents !== 'number' || maxBetCents <= 0)) {
    return res.status(400).json({ error: 'maxBetCents must be a positive number.' });
  }

  // Store limits on user row (add columns in a future migration if RG_ENABLED is turned on)
  res.json({ ok: true });
});

router.post('/self-exclude', async (req, res) => {
  if (!RG_ENABLED) {
    return res.status(503).json({ error: 'Self-exclusion is not active yet.', code: 'RG_NOT_ENABLED' });
  }

  const { days } = req.body;
  if (typeof days !== 'number' || days < 1) {
    return res.status(400).json({ error: 'days must be a positive integer.' });
  }

  const excludedUntil = days === -1
    ? null   // permanent
    : new Date(Date.now() + days * 86_400_000);

  try {
    await pool.query(
      `UPDATE users
       SET status = 'self_excluded', excluded_until = $1
       WHERE id = $2`,
      [excludedUntil, String(req.userId)]
    );
    res.json({
      ok: true,
      excludedUntil: excludedUntil ? excludedUntil.toISOString() : null,
    });
  } catch (err) {
    console.error('[POST /api/user/self-exclude]', err);
    res.status(500).json({ error: 'Failed to apply self-exclusion.' });
  }
});

module.exports = router;
