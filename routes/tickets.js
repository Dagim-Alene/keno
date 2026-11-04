'use strict';

/**
 * routes/tickets.js
 * POST /api/tickets — Place a bet ticket for the active live round.
 * 
 * Strict Server Authority:
 *   - Only accepted while live_rounds.status = 'betting' AND NOW() < betting_closes_at
 *   - Idempotency-Key prevents double charging
 *   - Rate limited per user and per IP
 *   - Limit checks (self-exclusion, age, daily loss, max bet)
 *   - Single atomic transaction for wallet debit and ticket creation
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool, withTransaction } = require('../db/pool');
const { debit, ensureUser } = require('../wallet');
const { checkAllLimits } = require('../services/limits');
const { PAYTABLE } = require('../paytable');
const { loadCaps } = require('../services/settlement');

// Rate limit: 30 tickets / min per user, 60 / min per IP
const ticketUserLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => String(req.userId || 'anonymous'),
  validate: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many tickets placed. Please slow down.' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const ticketIpLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyGenerator: (req) => req.ip,
  validate: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests from this IP address.' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const MIN_BET_CENTS = Number(process.env.MIN_BET_CENTS || 100);
const MAX_BET_CENTS = Number(process.env.MAX_BET_CENTS || 10_000);

router.post('/', ticketUserLimiter, ticketIpLimiter, async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }

  const { picks, bet, roundId } = req.body;

  // Validate picks
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
    return res.status(400).json({ error: 'Pick between 1 and 10 numbers.' });
  }
  const uniquePicks = [...new Set(picks)];
  if (uniquePicks.length !== picks.length || uniquePicks.some(n => !Number.isInteger(n) || n < 1 || n > 80)) {
    return res.status(400).json({ error: 'Picks must be unique integers from 1 to 80.' });
  }

  // Validate bet — must be a plain decimal number, no exponent notation, max 2 decimal places
  if (bet === null || bet === undefined || bet === '') {
    return res.status(400).json({ error: 'Invalid bet amount.' });
  }
  // Reject exponent notation (e.g. 1e2) and non-numeric strings at the source string level
  if (typeof bet === 'string' && /[eE]/.test(bet)) {
    return res.status(400).json({ error: 'Invalid bet amount.' });
  }
  const numBet = Number(bet);
  if (!isFinite(numBet) || isNaN(numBet) || numBet <= 0) {
    return res.status(400).json({ error: 'Invalid bet amount.' });
  }
  // Reject more than 2 decimal places (which would cause rounding ambiguity)
  if (Math.round(numBet * 100) !== numBet * 100) {
    return res.status(400).json({ error: 'Bet amount must have at most 2 decimal places.' });
  }
  const betCents = Math.round(numBet * 100);
  if (betCents < MIN_BET_CENTS || betCents > MAX_BET_CENTS) {
    return res.status(400).json({
      error: `Bet must be between ${(MIN_BET_CENTS / 100).toFixed(2)} and ${(MAX_BET_CENTS / 100).toFixed(2)} ETB.`
    });
  }

  // Check limits (read-only precheck)
  try {
    await checkAllLimits(req.userId, betCents, req);
  } catch (err) {
    const status = err.statusCode || 403;
    return res.status(status).json({ error: err.message, code: err.code });
  }

  // Idempotency check BEFORE transaction
  const { rows: existingRows } = await pool.query(
    `SELECT t.*, lr.round_number
     FROM tickets t
     JOIN live_rounds lr ON lr.id = t.round_id
     WHERE t.user_id = $1 AND t.idempotency_key = $2`,
    [String(req.userId), idempotencyKey]
  );
  if (existingRows.length > 0) {
    const row = existingRows[0];
    return res.json(formatTicketResponse(row));
  }

  try {
    let createdTicket = null;

    await withTransaction(async (client) => {
      // 1. Ensure user exists
      await ensureUser(client, req.userId, req.telegramUsername);

      // 2. Resolve target round
      let roundQuery;
      let roundParams;
      if (roundId) {
        roundQuery = `SELECT * FROM live_rounds WHERE id = $1 FOR UPDATE`;
        roundParams = [String(roundId)];
      } else {
        roundQuery = `SELECT * FROM live_rounds WHERE status = 'betting' ORDER BY round_number DESC LIMIT 1 FOR UPDATE`;
        roundParams = [];
      }

      const { rows: rRows } = await client.query(roundQuery, roundParams);
      if (rRows.length === 0) {
        const err = new Error('No active round accepting bets.');
        err.statusCode = 423;
        throw err;
      }

      const liveRound = rRows[0];

      // Verify betting window using database NOW()
      const { rows: timeCheck } = await client.query(
        `SELECT NOW() <= $1 AS is_open, NOW() AS db_now`,
        [liveRound.betting_closes_at]
      );
      if (liveRound.status !== 'betting' || !timeCheck[0].is_open) {
        const err = new Error('Betting is closed for this round.');
        err.statusCode = 423;
        throw err;
      }

      // 3. Check max tickets per user for this round
      const { rows: cfgRows } = await client.query(
        `SELECT value FROM game_config WHERE key = 'max_tickets_per_round'`
      );
      const maxTickets = Number(cfgRows[0]?.value || 3);

      const { rows: userTicketCount } = await client.query(
        `SELECT COUNT(*)::int AS count FROM tickets WHERE round_id = $1 AND user_id = $2`,
        [liveRound.id, String(req.userId)]
      );
      if (userTicketCount[0].count >= maxTickets) {
        const err = new Error(`Maximum ${maxTickets} tickets allowed per round.`);
        err.statusCode = 429;
        throw err;
      }

      // 4. House protection caps check
      const caps = await loadCaps(client);
      const tbl = PAYTABLE[uniquePicks.length] || {};
      const maxMultiplier = Math.max(...Object.values(tbl), 0);
      const maxPossiblePayout = BigInt(Math.floor(betCents * maxMultiplier));

      if (maxPossiblePayout > BigInt(caps.maxPerTicket * 10)) {
        // Excessive ticket payout cap rejection
        const err = new Error('Bet amount exceeds maximum potential ticket payout limit.');
        err.statusCode = 400;
        throw err;
      }

      // 5. Debit wallet inside transaction
      const { ledgerId } = await debit(
        req.userId,
        'ETB',
        betCents,
        'bet',
        'ticket',
        null, // will back-fill with ticket id
        idempotencyKey,
        client
      );

      // 6. Insert ticket
      const { rows: tRows } = await client.query(
        `INSERT INTO tickets
           (round_id, user_id, picks, bet, status, ledger_bet_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 'open', $5, $6)
         RETURNING *`,
        [liveRound.id, String(req.userId), uniquePicks, String(betCents), String(ledgerId), idempotencyKey]
      );

      const ticket = tRows[0];

      // Back-fill ref_id in ledger
      await client.query(
        `UPDATE ledger_entries SET ref_id = $1 WHERE id = $2`,
        [String(ticket.id), String(ledgerId)]
      );

      ticket.round_number = liveRound.round_number;
      createdTicket = ticket;
    });

    res.status(201).json(formatTicketResponse(createdTicket));

  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Insufficient balance.', code: err.code });
    }
    console.error('[POST /api/tickets]', err);
    res.status(500).json({ error: 'Failed to place ticket.' });
  }
});

function formatTicketResponse(row) {
  return {
    id: String(row.id),
    roundId: String(row.round_id),
    roundNumber: Number(row.round_number),
    userId: String(row.user_id),
    picks: row.picks,
    bet: Number(row.bet) / 100,
    status: row.status,
    payout: row.payout != null ? Number(row.payout) / 100 : null,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
  };
}

module.exports = router;
