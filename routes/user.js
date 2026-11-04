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
  const { dailyLossLimitCents, maxBetCents } = req.body;

  if (dailyLossLimitCents !== undefined &&
      (typeof dailyLossLimitCents !== 'number' || dailyLossLimitCents < 0)) {
    return res.status(400).json({ error: 'dailyLossLimitCents must be a non-negative number.' });
  }
  if (maxBetCents !== undefined &&
      (typeof maxBetCents !== 'number' || maxBetCents <= 0)) {
    return res.status(400).json({ error: 'maxBetCents must be a positive number.' });
  }

  try {
    const updates = [];
    const params = [];
    let idx = 1;

    if (dailyLossLimitCents !== undefined) {
      updates.push(`daily_loss_limit_cents = $${idx++}`);
      params.push(dailyLossLimitCents === 0 ? null : dailyLossLimitCents);
    }
    if (maxBetCents !== undefined) {
      updates.push(`max_bet_cents = $${idx++}`);
      params.push(maxBetCents);
    }

    if (updates.length > 0) {
      params.push(String(req.userId));
      await pool.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
        params
      );
    }

    res.json({ ok: true, dailyLossLimitCents, maxBetCents });
  } catch (err) {
    console.error('[POST /api/user/limits]', err);
    res.status(500).json({ error: 'Failed to update limits.' });
  }
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
