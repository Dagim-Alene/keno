'use strict';

/**
 * routes/health.js
 * GET /health — reports database, scheduler, and system status
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { getScheduler } = require('../services/scheduler');

router.get('/health', async (req, res) => {
  let dbStatus = 'ok';
  let dbError = null;

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    dbStatus = 'error';
    dbError = err.message;
  }

  const scheduler = getScheduler();
  const schedStatus = scheduler.getStatus();

  const isHealthy = (dbStatus === 'ok');

  const payload = {
    status: isHealthy ? 'ok' : 'degraded',
    db: dbStatus,
    dbError,
    scheduler: {
      running: schedStatus.running,
      hasLock: schedStatus.hasLock,
      currentRound: schedStatus.currentRound ? {
        id: schedStatus.currentRound.id,
        roundNumber: schedStatus.currentRound.roundNumber,
        status: schedStatus.currentRound.status,
      } : null,
    },
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  res.status(isHealthy ? 200 : 503).json(payload);
});

module.exports = router;
