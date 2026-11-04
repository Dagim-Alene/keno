'use strict';

/**
 * routes/live.js
 * GET /api/live — Server-Sent Events (SSE) stream for live shared Keno rounds.
 * Supports polling fallback via ?poll=1 query param.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { getBalance } = require('../wallet');
const { addClient, removeClient, sendEvent } = require('../services/sse');
const { getScheduler } = require('../services/scheduler');

const MIN_BET_CENTS = Number(process.env.MIN_BET_CENTS || 100);
const MAX_BET_CENTS = Number(process.env.MAX_BET_CENTS || 10_000);

async function buildSnapshot(userId) {
  const scheduler = getScheduler();
  const schedStatus = scheduler.getStatus();
  const now = scheduler.getNow();

  // 1. Current round details
  let currentRound = schedStatus.currentRound;
  if (!currentRound) {
    const { rows: activeRows } = await pool.query(
      `SELECT * FROM live_rounds
       WHERE status IN ('betting', 'locked', 'drawing', 'result')
       ORDER BY round_number DESC LIMIT 1`
    );
    if (activeRows.length > 0) {
      currentRound = scheduler.formatRoundForPublic(activeRows[0]);
    }
  }

  // 2. My tickets for the current round
  let myTickets = [];
  if (userId && currentRound) {
    const { rows } = await pool.query(
      `SELECT id, round_id, picks, bet, status, payout, created_at, settled_at
       FROM tickets
       WHERE round_id = $1 AND user_id = $2
       ORDER BY created_at ASC`,
      [currentRound.id, String(userId)]
    );
    myTickets = rows.map(r => ({
      id: String(r.id),
      roundId: String(r.round_id),
      roundNumber: currentRound.roundNumber,
      picks: r.picks,
      bet: Number(r.bet) / 100,
      status: r.status,
      payout: r.payout != null ? Number(r.payout) / 100 : null,
      createdAt: new Date(r.created_at).toISOString(),
      settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    }));
  }

  // 3. Last 10 settled rounds
  const { rows: historyRows } = await pool.query(
    `SELECT id, round_number, status, drawn, server_seed, server_seed_hash, settled_at
     FROM live_rounds
     WHERE status = 'settled'
     ORDER BY round_number DESC
     LIMIT 10`
  );
  const lastResults = historyRows.map(r => ({
    id: String(r.id),
    roundNumber: Number(r.round_number),
    status: r.status,
    drawn: r.drawn,
    serverSeed: r.server_seed,
    serverSeedHash: r.server_seed_hash,
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
  }));

  // 4. User balance
  let balance = 0;
  if (userId) {
    const balCents = await getBalance(userId, 'ETB');
    balance = Number(balCents) / 100;
  }

  // 5. Config / paused status
  const config = await scheduler.loadConfig();

  // If mid-draw, calculate drawn balls so far based on timeline
  let drawnSoFar = null;
  if (currentRound && currentRound.status === 'drawing' && currentRound.drawn && currentRound.drawStartsAt && currentRound.resultStartsAt) {
    const start = new Date(currentRound.drawStartsAt).getTime();
    const end = new Date(currentRound.resultStartsAt).getTime();
    const duration = Math.max(1000, end - start);
    const elapsed = Math.max(0, now - start);
    const count = Math.min(20, Math.floor((elapsed / duration) * 20) + 1);
    drawnSoFar = currentRound.drawn.slice(0, count);
  } else if (currentRound && (currentRound.status === 'result' || currentRound.status === 'settled')) {
    drawnSoFar = currentRound.drawn;
  }

  const roundPayload = currentRound ? {
    ...currentRound,
    drawnSoFar,
  } : null;

  return {
    round: roundPayload,
    myTickets,
    lastResults,
    paused: config.paused,
    balance,
    minBet: MIN_BET_CENTS / 100,
    maxBet: MAX_BET_CENTS / 100,
    serverTime: now,
  };
}

router.get('/', async (req, res) => {
  const userId = req.userId ? String(req.userId) : null;

  // Polling fallback
  if (req.query.poll === '1' || req.query.poll === 'true') {
    try {
      const snapshot = await buildSnapshot(userId);
      return res.json(snapshot);
    } catch (err) {
      console.error('[GET /api/live?poll=1]', err);
      return res.status(500).json({ error: 'Failed to build state snapshot' });
    }
  }

  // SSE Stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  if (userId) {
    addClient(userId, res);
  }

  // Send initial snapshot
  try {
    const snapshot = await buildSnapshot(userId);
    sendEvent(res, 'snapshot', snapshot);
  } catch (err) {
    console.error('[GET /api/live initial snapshot]', err);
  }

  // Heartbeat ping every 15s
  const pingInterval = setInterval(() => {
    sendEvent(res, 'ping', { serverTime: Date.now() });
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    if (userId) {
      removeClient(userId, res);
    }
  });
});

module.exports = router;
module.exports.buildSnapshot = buildSnapshot;
