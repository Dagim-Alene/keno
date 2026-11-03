'use strict';

/**
 * routes/play.js
 * POST /api/play
 */

const express     = require('express');
const router      = express.Router();
const rateLimit   = require('express-rate-limit');
const { playRound } = require('../services/keno');

// Rate limiting on /api/play: active both per user AND per IP
const userLimiter = rateLimit({
  windowMs: Number(process.env.PLAY_RATE_LIMIT_WINDOW_MS || 60_000),
  max:      Number(process.env.PLAY_RATE_LIMIT_MAX       || 30),
  keyGenerator: (req) => String(req.userId || 'anonymous'),
  validate: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many plays for this user. Please slow down.' });
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

const ipLimiter = rateLimit({
  windowMs: Number(process.env.PLAY_RATE_LIMIT_WINDOW_MS || 60_000),
  max:      Number(process.env.PLAY_RATE_LIMIT_MAX       || 30),
  keyGenerator: (req) => req.ip,
  validate: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many plays from this IP address. Please slow down.' });
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

router.post('/', userLimiter, ipLimiter, async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }

  const { picks, bet } = req.body;
  const numBet = Number(bet);

  // Input validation (mirrors original server.js)
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
    return res.status(400).json({ error: 'Pick between 1 and 10 numbers.' });
  }
  const uniquePicks = [...new Set(picks)];
  if (uniquePicks.length !== picks.length || uniquePicks.some(n => n < 1 || n > 80)) {
    return res.status(400).json({ error: 'Invalid pick numbers. Must be 1-80 without duplicates.' });
  }
  if (isNaN(numBet) || numBet <= 0) {
    return res.status(400).json({ error: 'Invalid bet amount.' });
  }

  try {
    const result = await playRound(
      req.userId,
      req.telegramUsername,
      uniquePicks,
      numBet,
      idempotencyKey,
      req
    );
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    // Known client errors
    if (['INSUFFICIENT_BALANCE','MAX_BET_EXCEEDED','DAILY_LOSS_LIMIT',
         'SELF_EXCLUDED','SUSPENDED','UNDERAGE','GEO_BLOCKED'].includes(err.code)) {
      return res.status(status).json({ error: err.message, code: err.code });
    }
    console.error('[POST /api/play]', err);
    res.status(500).json({ error: 'Game round failed. Your balance has not been changed.' });
  }
});

module.exports = router;
