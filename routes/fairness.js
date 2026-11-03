'use strict';

/**
 * routes/fairness.js
 * POST /api/fairness/rotate   — rotate seed pair, reveal old server seed
 * POST /api/fairness/client-seed — update the client seed
 */

const express  = require('express');
const router   = express.Router();
const { rotateSeedPair, updateClientSeed } = require('../services/seeds');

router.post('/rotate', async (req, res) => {
  try {
    const result = await rotateSeedPair(req.userId);
    res.json({
      previousServerSeed: result.previousServerSeed,
      newServerSeedHash:  result.newServerSeedHash,
      nonce:              Number(result.nonce),
    });
  } catch (err) {
    console.error('[POST /api/fairness/rotate]', err);
    res.status(500).json({ error: 'Seed rotation failed. Please try again.' });
  }
});

router.post('/client-seed', async (req, res) => {
  const { clientSeed } = req.body;
  if (!clientSeed || typeof clientSeed !== 'string' || clientSeed.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid client seed.' });
  }
  try {
    const result = await updateClientSeed(req.userId, clientSeed.trim().slice(0, 64));
    res.json({ clientSeed: result.clientSeed });
  } catch (err) {
    console.error('[POST /api/fairness/client-seed]', err);
    res.status(500).json({ error: 'Failed to update client seed.' });
  }
});

module.exports = router;
