'use strict';

/**
 * routes/payments.js
 * POST /api/deposit/create         — create a deposit intent
 * POST /webhooks/payments          — payment provider webhook (HMAC verified, idempotent)
 * POST /api/withdraw/request       — request a withdrawal (debits immediately)
 * POST /api/admin/withdraw/:id/approve — admin: approve withdrawal
 * POST /api/admin/withdraw/:id/reject  — admin: reject + refund withdrawal
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const { credit, debit }         = require('../wallet');
const provider                  = require('../payments/provider');
const { checkSelfExclusion }     = require('../services/limits');

// ---------------------------------------------------------------------------
// Admin auth middleware
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not configured.' });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(token || ''), Buffer.from(expected))) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
  } catch {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// POST /api/deposit/create
// ---------------------------------------------------------------------------
router.post('/api/deposit/create', async (req, res) => {
  const { amountCents, currency = 'USD' } = req.body;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'amountCents must be a positive integer.' });
  }

  const idempotencyKey = req.headers['idempotency-key'] || null;

  try {
    // Self-exclusion blocks deposits
    await checkSelfExclusion(req.userId);

    const result = await provider.createDeposit(req.userId, amountCents, currency, idempotencyKey);
    res.json(result);
  } catch (err) {
    if (err.code === 'SELF_EXCLUDED' || err.code === 'SUSPENDED') {
      return res.status(err.statusCode || 403).json({ error: err.message, code: err.code });
    }
    console.error('[POST /api/deposit/create]', err);
    res.status(500).json({ error: 'Failed to create deposit.' });
  }
});

// ---------------------------------------------------------------------------
// POST /webhooks/payments
// HMAC-verified, idempotent: credits wallet once per payment id.
// ---------------------------------------------------------------------------
router.post('/webhooks/payments', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-payment-signature'] || '';
  if (!provider.verifyWebhookSignature(req.body, signature)) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  const { paymentId, userId, amountCents, currency = 'USD' } = payload;
  if (!paymentId || !userId || !amountCents) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Idempotency key = paymentId
  try {
    const { balanceAfter } = await credit(
      userId, currency, amountCents,
      'deposit', 'payment', String(paymentId),
      `webhook_${paymentId}`
    );
    res.json({ ok: true, balanceAfter: Number(balanceAfter) / 100 });
  } catch (err) {
    console.error('[POST /webhooks/payments]', err);
    res.status(500).json({ error: 'Failed to credit deposit.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/withdraw/request
// ---------------------------------------------------------------------------
router.post('/api/withdraw/request', async (req, res) => {
  const { amountCents, currency = 'USD' } = req.body;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'amountCents must be a positive integer.' });
  }

  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }

  try {
    let withdrawalId, ledgerDebitId;

    await withTransaction(async (client) => {
      // Debit immediately
      const { ledgerId, balanceAfter } = await debit(
        req.userId, currency, amountCents,
        'withdrawal', 'withdrawal_request', null,
        idempotencyKey, client
      );
      ledgerDebitId = ledgerId;

      // Insert withdrawal request row
      const { rows } = await client.query(
        `INSERT INTO withdrawal_requests (user_id, currency, amount_cents, ledger_debit_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [String(req.userId), currency, amountCents, String(ledgerDebitId)]
      );
      withdrawalId = rows[0].id;

      // Back-fill ref_id on the debit ledger entry
      await client.query(
        `UPDATE ledger_entries SET ref_id = $1 WHERE id = $2`,
        [String(withdrawalId), String(ledgerDebitId)]
      );
    });

    res.json({ ok: true, withdrawalId, status: 'pending' });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Insufficient balance for withdrawal.' });
    }
    console.error('[POST /api/withdraw/request]', err);
    res.status(500).json({ error: 'Failed to create withdrawal request.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/withdraw/:id/approve
// ---------------------------------------------------------------------------
router.post('/api/admin/withdraw/:id/approve', requireAdmin, async (req, res) => {
  const wId = Number(req.params.id);

  try {
    await pool.query(
      `UPDATE withdrawal_requests
       SET status = 'approved', updated_at = NOW(), admin_note = $1
       WHERE id = $2 AND status = 'pending'`,
      [req.body.note || null, wId]
    );
    res.json({ ok: true, withdrawalId: wId, status: 'approved' });
  } catch (err) {
    console.error('[POST /api/admin/withdraw/:id/approve]', err);
    res.status(500).json({ error: 'Failed to approve withdrawal.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/withdraw/:id/reject  — refund via ledger 'refund' entry
// ---------------------------------------------------------------------------
router.post('/api/admin/withdraw/:id/reject', requireAdmin, async (req, res) => {
  const wId = Number(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 AND status = 'pending'`,
      [wId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal request not found or already processed.' });
    }
    const wr = rows[0];

    let refundLedgerId;
    await withTransaction(async (client) => {
      const { ledgerId } = await credit(
        wr.user_id, wr.currency, wr.amount_cents,
        'refund', 'withdrawal_request', String(wId),
        `refund_withdrawal_${wId}`, client
      );
      refundLedgerId = ledgerId;

      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'rejected', updated_at = NOW(),
             ledger_refund_id = $1, admin_note = $2
         WHERE id = $3`,
        [String(refundLedgerId), req.body.note || null, wId]
      );
    });

    res.json({ ok: true, withdrawalId: wId, status: 'rejected' });
  } catch (err) {
    console.error('[POST /api/admin/withdraw/:id/reject]', err);
    res.status(500).json({ error: 'Failed to reject withdrawal.' });
  }
});

module.exports = router;
