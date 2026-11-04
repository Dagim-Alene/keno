'use strict';

/**
 * routes/admin.js
 * Admin & Manual Payments System
 * 
 * Part B:
 *   - Player manual deposit request flow (POST /api/deposit/request)
 *   - Player wallet history (GET /api/wallet/history)
 *   - Admin deposit approval / rejection
 *   - Admin withdrawal approval / rejection
 *   - Admin game pause / resume killswitch
 *   - Admin audit log
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { pool, withTransaction } = require('../db/pool');
const { credit, debit, getBalance } = require('../wallet');
const { checkSelfExclusion } = require('../services/limits');
const { notifyUser, notifyAdmin } = require('../services/notify');

const DEPOSIT_MIN_CENTS    = Number(process.env.DEPOSIT_MIN_CENTS || 1000);   // 10 ETB
const DEPOSIT_MAX_CENTS    = Number(process.env.DEPOSIT_MAX_CENTS || 10_000_000); // 100,000 ETB
const DEPOSIT_MAX_PENDING  = Number(process.env.DEPOSIT_MAX_PENDING || 3);
const DEPOSIT_EXPIRY_HOURS = Number(process.env.DEPOSIT_EXPIRY_HOURS || 24);

const WITHDRAWAL_TURNOVER_MULTIPLIER = Number(process.env.WITHDRAWAL_TURNOVER_MULTIPLIER || 0);

// Admin authentication middleware
function requireAdmin(req, res, next) {
  // Reject tokens in URL query string to avoid leaking secrets in URLs/access logs
  if (req.query && (req.query.token || req.query.admin_token || req.query.adminToken)) {
    return res.status(400).json({ error: 'Admin token must be provided via headers, not query parameters.' });
  }

  // Refuse non-HTTPS requests in production (respecting trust proxy)
  if (process.env.NODE_ENV === 'production') {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (!isHttps) {
      return res.status(403).json({ error: 'HTTPS required for admin access in production.' });
    }
  }

  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not configured.' });
  }
  if (!token) {
    return res.status(403).json({ error: 'Admin authentication required.' });
  }
  try {
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
      return res.status(403).json({ error: 'Invalid admin token.' });
    }
  } catch {
    return res.status(403).json({ error: 'Invalid admin token.' });
  }
  req.adminId = req.headers['x-admin-id'] || 'admin_1';
  next();
}

async function writeAuditLog(adminId, action, entityType, entityId, details, req) {
  const ip = req?.ip || req?.headers['x-forwarded-for'] || null;
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, action, entityType, String(entityId), JSON.stringify(details || {}), ip]
    );
  } catch (err) {
    console.error('[writeAuditLog error]', err);
  }
}

// ---------------------------------------------------------------------------
// PLAYER: POST /api/deposit/request
// ---------------------------------------------------------------------------
router.post('/api/deposit/request', async (req, res) => {
  const rawAmount = req.body.amountCents ?? (req.body.amount != null ? Math.round(Number(req.body.amount) * 100) : null);
  const amountCents = Number(rawAmount);
  const method = (req.body.method || 'telebirr').trim().toLowerCase();
  const txReference = (req.body.txReference || req.body.transactionReference || '').trim();
  const proofText = (req.body.proofText || req.body.note || '').trim();

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Invalid deposit amount.' });
  }
  if (amountCents < DEPOSIT_MIN_CENTS || amountCents > DEPOSIT_MAX_CENTS) {
    return res.status(400).json({
      error: `Deposit must be between ${(DEPOSIT_MIN_CENTS / 100).toFixed(2)} and ${(DEPOSIT_MAX_CENTS / 100).toFixed(2)} ETB.`
    });
  }

  try {
    await checkSelfExclusion(req.userId);

    // Auto-expire old pending deposits
    await pool.query(
      `UPDATE deposit_requests
       SET status = 'expired'
       WHERE user_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
      [String(req.userId)]
    );

    // Check max pending requests
    const { rows: pendingRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM deposit_requests WHERE user_id = $1 AND status = 'pending'`,
      [String(req.userId)]
    );
    if (pendingRows[0].count >= DEPOSIT_MAX_PENDING) {
      return res.status(429).json({
        error: `You already have ${DEPOSIT_MAX_PENDING} pending deposit requests. Please wait for approval.`
      });
    }

    const referenceCode = 'DEP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + DEPOSIT_EXPIRY_HOURS * 3600 * 1000);

    const { rows } = await pool.query(
      `INSERT INTO deposit_requests
         (user_id, amount_cents, claimed_amount_cents, method, reference_code, tx_reference, status, note, expires_at)
       VALUES ($1, $2, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING *`,
      [String(req.userId), amountCents, method, referenceCode, txReference, proofText, expiresAt]
    );

    const created = rows[0];

    // Notify admins
    notifyAdmin(
      `📥 <b>New Deposit Request</b>\nUser: <code>${req.userId}</code>\nAmount: <b>${(amountCents / 100).toFixed(2)} ETB</b>\nMethod: ${method}\nRef Code: <code>${referenceCode}</code>\nTx: ${txReference || '—'}`
    );

    res.status(201).json({
      ok: true,
      requestId: String(created.id),
      referenceCode: created.reference_code,
      amount: amountCents / 100,
      method: created.method,
      status: created.status,
      expiresAt: created.expires_at.toISOString(),
      instructions: method === 'telebirr'
        ? 'Send funds to TeleBirr 0982127526 with reference code in remarks.'
        : 'Send funds to CBE account 1000511782727 with reference code in remarks.',
    });
  } catch (err) {
    if (err.code === '23505' && (err.constraint === 'uq_deposit_requests_method_tx_ref' || /tx_ref/i.test(err.message))) {
      return res.status(409).json({ error: 'A deposit with this transaction reference already exists for this payment method.' });
    }
    if (err.code === 'SELF_EXCLUDED' || err.code === 'SUSPENDED') {
      return res.status(err.statusCode || 403).json({ error: err.message, code: err.code });
    }
    console.error('[POST /api/deposit/request]', err);
    res.status(500).json({ error: 'Failed to create deposit request.' });
  }
});

// ---------------------------------------------------------------------------
// PLAYER: GET /api/wallet/history
// ---------------------------------------------------------------------------
router.get('/api/wallet/history', async (req, res) => {
  try {
    const userId = String(req.userId);

    const { rows: deposits } = await pool.query(
      `SELECT id, amount_cents, method, reference_code, tx_reference, status, note, created_at, decided_at
       FROM deposit_requests
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    const { rows: withdrawals } = await pool.query(
      `SELECT id, amount_cents, currency, account_method, account_number, status, admin_note, created_at, updated_at
       FROM withdrawal_requests
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    res.json({
      deposits: deposits.map(d => ({
        id: String(d.id),
        amount: Number(d.amount_cents) / 100,
        method: d.method,
        referenceCode: d.reference_code,
        txReference: d.tx_reference,
        status: d.status,
        note: d.note,
        createdAt: new Date(d.created_at).toISOString(),
        decidedAt: d.decided_at ? new Date(d.decided_at).toISOString() : null,
      })),
      withdrawals: withdrawals.map(w => ({
        id: String(w.id),
        amount: Number(w.amount_cents) / 100,
        currency: w.currency,
        accountMethod: w.account_method,
        accountNumber: w.account_number,
        status: w.status,
        adminNote: w.admin_note,
        createdAt: new Date(w.created_at).toISOString(),
        updatedAt: w.updated_at ? new Date(w.updated_at).toISOString() : null,
      })),
    });
  } catch (err) {
    console.error('[GET /api/wallet/history]', err);
    res.status(500).json({ error: 'Failed to fetch wallet history' });
  }
});

// ---------------------------------------------------------------------------
// PLAYER: POST /api/withdraw/request with turnover verification
// ---------------------------------------------------------------------------
router.post('/api/withdraw/request', async (req, res) => {
  const raw = req.body.amount ?? req.body.amountCents;
  const amountCents = Number(raw);
  const currency = req.body.currency || 'ETB';
  const accountMethod = (req.body.accountMethod || 'telebirr').trim();
  const accountNumber = (req.body.accountNumber || '').trim();

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'amount must be a positive integer (in cents).' });
  }
  if (!accountNumber) {
    return res.status(400).json({ error: 'accountNumber is required.' });
  }

  try {
    await checkSelfExclusion(req.userId);

    // 24-hour cooling-off check after a payout destination change
    const destinationKey = `${accountMethod}:${accountNumber}`;
    const { rows: uRows } = await pool.query(
      `SELECT last_payout_destination, payout_destination_updated_at FROM users WHERE id = $1`,
      [String(req.userId)]
    );
    if (uRows.length > 0) {
      const userRec = uRows[0];
      if (userRec.last_payout_destination && userRec.last_payout_destination !== destinationKey) {
        // Destination has changed or is changing
        if (userRec.payout_destination_updated_at) {
          const diffMs = Date.now() - new Date(userRec.payout_destination_updated_at).getTime();
          const coolingPeriodMs = 24 * 3600 * 1000;
          if (diffMs < coolingPeriodMs) {
            const hoursLeft = Math.ceil((coolingPeriodMs - diffMs) / (3600 * 1000));
            return res.status(403).json({
              error: `Payout destination was recently changed. 24-hour cooling-off period active (${hoursLeft}h remaining).`
            });
          }
        }
      }
    }

    // Turnover check if enabled
    if (WITHDRAWAL_TURNOVER_MULTIPLIER > 0) {
      const { rows: depSumRows } = await pool.query(
        `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_dep
         FROM deposit_requests WHERE user_id = $1 AND status = 'approved'`,
        [String(req.userId)]
      );
      const totalDeposits = BigInt(depSumRows[0].total_dep);
      const requiredWager = totalDeposits * BigInt(Math.round(WITHDRAWAL_TURNOVER_MULTIPLIER * 100)) / 100n;

      const { rows: wagerRows } = await pool.query(
        `SELECT COALESCE(SUM(bet), 0)::bigint AS total_wager
         FROM tickets WHERE user_id = $1`,
        [String(req.userId)]
      );
      const actualWager = BigInt(wagerRows[0].total_wager);

      if (actualWager < requiredWager) {
        return res.status(400).json({
          error: `Turnover requirement not met. You must wager at least ${(Number(requiredWager) / 100).toFixed(2)} ETB before withdrawing.`
        });
      }
    }

    const idempotencyKey = req.headers['idempotency-key'] || `wdr-${req.userId}-${Date.now()}`;
    let withdrawalId;

    await withTransaction(async (client) => {
      const { ledgerId } = await debit(
        req.userId, currency, amountCents,
        'withdrawal', 'withdrawal_request', null,
        idempotencyKey, client
      );

      const { rows } = await client.query(
        `INSERT INTO withdrawal_requests (user_id, currency, amount_cents, ledger_debit_id, account_method, account_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [String(req.userId), currency, amountCents, String(ledgerId), accountMethod, accountNumber]
      );
      withdrawalId = rows[0].id;

      await client.query(
        `UPDATE ledger_entries SET ref_id = $1 WHERE id = $2`,
        [String(withdrawalId), String(ledgerId)]
      );

      // Record / update destination on user if different
      await client.query(
        `UPDATE users
         SET last_payout_destination = $1,
             payout_destination_updated_at = CASE 
               WHEN last_payout_destination IS DISTINCT FROM $1 THEN NOW() 
               ELSE payout_destination_updated_at 
             END
         WHERE id = $2`,
        [destinationKey, String(req.userId)]
      );
    });

    notifyAdmin(
      `💸 <b>New Withdrawal Request</b>\nUser: <code>${req.userId}</code>\nAmount: <b>${(amountCents / 100).toFixed(2)} ETB</b>\nMethod: ${accountMethod}\nAccount: <code>${accountNumber}</code>`
    );

    res.json({ ok: true, withdrawalId: String(withdrawalId), status: 'pending' });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Insufficient balance for withdrawal.' });
    }
    console.error('[POST /api/withdraw/request]', err);
    res.status(500).json({ error: 'Failed to create withdrawal request.' });
  }
});

// ---------------------------------------------------------------------------
// ADMIN ENDPOINTS
// ---------------------------------------------------------------------------

// GET /api/admin/deposits
router.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const { rows } = await pool.query(
      `SELECT d.*, u.username
       FROM deposit_requests d
       JOIN users u ON u.id = d.user_id
       WHERE d.status = $1
       ORDER BY d.created_at ASC
       LIMIT 100`,
      [status]
    );
    res.json(rows.map(r => ({
      id: String(r.id),
      userId: String(r.user_id),
      username: r.username || '—',
      amount: Number(r.amount_cents) / 100,
      method: r.method,
      referenceCode: r.reference_code,
      txReference: r.tx_reference,
      status: r.status,
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
    })));
  } catch (err) {
    console.error('[GET /api/admin/deposits]', err);
    res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

// POST /api/admin/deposits/:id/approve
router.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows: dRows } = await pool.query(
      `SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (dRows.length === 0) {
      return res.status(404).json({ error: 'Deposit request not found.' });
    }
    const dep = dRows[0];
    if (dep.status !== 'pending') {
      return res.status(400).json({ error: `Cannot approve deposit with status: ${dep.status}` });
    }

    // Admin must enter the amount actually received (in ETB or cents)
    // If not provided, fallback to dep.amount_cents
    let receivedAmountCents;
    if (req.body.receivedAmount != null || req.body.receivedAmountCents != null) {
      const rawRecv = req.body.receivedAmountCents != null
        ? Number(req.body.receivedAmountCents)
        : Math.round(Number(req.body.receivedAmount) * 100);
      if (!Number.isInteger(rawRecv) || rawRecv <= 0) {
        return res.status(400).json({ error: 'Valid receivedAmount must be provided.' });
      }
      receivedAmountCents = BigInt(rawRecv);
    } else {
      receivedAmountCents = BigInt(dep.amount_cents);
    }

    const ikey = `deposit_approval_${id}`;
    let creditId;

    await withTransaction(async (client) => {
      // Credit the amount actually received
      const { ledgerId } = await credit(
        dep.user_id, 'ETB', receivedAmountCents,
        'deposit', 'deposit_request', String(id),
        ikey, client
      );
      creditId = ledgerId;

      await client.query(
        `UPDATE deposit_requests
         SET status = 'approved', admin_id = $1, decided_at = NOW(),
             ledger_credit_id = $2, note = $3,
             received_amount_cents = $4,
             claimed_amount_cents = COALESCE(claimed_amount_cents, amount_cents),
             amount_cents = $4
         WHERE id = $5 AND status = 'pending'`,
        [req.adminId, String(creditId), req.body.note || null, String(receivedAmountCents), id]
      );
    });

    await writeAuditLog(req.adminId, 'deposit_approve', 'deposit_request', id, {
      claimedAmount: Number(dep.claimed_amount_cents || dep.amount_cents) / 100,
      receivedAmount: Number(receivedAmountCents) / 100,
      userId: String(dep.user_id)
    }, req);

    notifyUser(
      dep.user_id,
      `✅ <b>Deposit Approved!</b>\nYour deposit of <b>${(Number(receivedAmountCents) / 100).toFixed(2)} ETB</b> has been credited to your account.`
    );

    res.json({ ok: true, id, status: 'approved', receivedAmount: Number(receivedAmountCents) / 100 });
  } catch (err) {
    console.error('[POST /api/admin/deposits/:id/approve]', err);
    res.status(500).json({ error: 'Failed to approve deposit.' });
  }
});

// POST /api/admin/deposits/:id/reject
router.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const note = req.body.note || 'Rejected by administrator';
  try {
    const { rows: dRows } = await pool.query(
      `SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (dRows.length === 0) {
      return res.status(404).json({ error: 'Deposit request not found.' });
    }
    const dep = dRows[0];
    if (dep.status !== 'pending') {
      return res.status(400).json({ error: `Cannot reject deposit with status: ${dep.status}` });
    }

    await pool.query(
      `UPDATE deposit_requests
       SET status = 'rejected', admin_id = $1, decided_at = NOW(), note = $2
       WHERE id = $3 AND status = 'pending'`,
      [req.adminId, note, id]
    );

    await writeAuditLog(req.adminId, 'deposit_reject', 'deposit_request', id, { note, userId: String(dep.user_id) }, req);

    notifyUser(
      dep.user_id,
      `❌ <b>Deposit Rejected</b>\nYour deposit request (Ref: ${dep.reference_code}) was rejected.\nReason: ${note}`
    );

    res.json({ ok: true, id, status: 'rejected' });
  } catch (err) {
    console.error('[POST /api/admin/deposits/:id/reject]', err);
    res.status(500).json({ error: 'Failed to reject deposit.' });
  }
});

// GET /api/admin/withdrawals
router.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const { rows } = await pool.query(
      `SELECT w.*, u.username
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       WHERE w.status = $1
       ORDER BY w.created_at ASC
       LIMIT 100`,
      [status]
    );
    res.json(rows.map(r => ({
      id: String(r.id),
      userId: String(r.user_id),
      username: r.username || '—',
      amount: Number(r.amount_cents) / 100,
      currency: r.currency,
      accountMethod: r.account_method,
      accountNumber: r.account_number,
      status: r.status,
      adminNote: r.admin_note,
      createdAt: new Date(r.created_at).toISOString(),
    })));
  } catch (err) {
    console.error('[GET /api/admin/withdrawals]', err);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// POST /api/admin/withdraw/:id/approve
router.post('/api/admin/withdraw/:id/approve', requireAdmin, async (req, res) => {
  const wId = Number(req.params.id);
  const note = req.body.note || 'Marked as paid';
  try {
    const { rows } = await pool.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [wId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Withdrawal not found' });
    const wr = rows[0];
    if (wr.status !== 'pending') {
      return res.status(400).json({ error: `Cannot approve withdrawal with status: ${wr.status}` });
    }

    // Two-admin approval logic above configurable threshold
    const SECOND_ADMIN_THRESHOLD_CENTS = Number(process.env.SECOND_ADMIN_THRESHOLD_CENTS || 500000); // default 5000 ETB
    const amountCents = BigInt(wr.amount_cents);

    if (amountCents >= BigInt(SECOND_ADMIN_THRESHOLD_CENTS)) {
      if (!wr.first_approved_by) {
        // First approval step
        await pool.query(
          `UPDATE withdrawal_requests
           SET first_approved_by = $1, first_approved_at = NOW(), requires_second_approval = true, admin_note = $2
           WHERE id = $3`,
          [req.adminId, `1st approval by ${req.adminId}: ${note}`, wId]
        );
        await writeAuditLog(req.adminId, 'withdrawal_first_approval', 'withdrawal_request', wId, { note, userId: String(wr.user_id), amount: Number(amountCents) / 100 }, req);
        return res.json({ ok: true, withdrawalId: wId, status: 'pending', pendingSecondApproval: true, message: 'First approval recorded. Requires second admin approval.' });
      } else if (wr.first_approved_by === req.adminId) {
        return res.status(400).json({ error: 'Second approval must be performed by a different administrator.' });
      } else {
        // Second admin approves -> finalize
        await pool.query(
          `UPDATE withdrawal_requests
           SET status = 'approved', updated_at = NOW(), second_approved_by = $1, second_approved_at = NOW(), admin_note = $2
           WHERE id = $3 AND status = 'pending'`,
          [req.adminId, `${wr.admin_note} | 2nd approval by ${req.adminId}: ${note}`, wId]
        );
      }
    } else {
      // Direct single approval
      await pool.query(
        `UPDATE withdrawal_requests
         SET status = 'approved', updated_at = NOW(), admin_note = $1, first_approved_by = $2, first_approved_at = NOW()
         WHERE id = $3 AND status = 'pending'`,
        [note, req.adminId, wId]
      );
    }

    await writeAuditLog(req.adminId, 'withdrawal_approve', 'withdrawal_request', wId, { note, userId: String(wr.user_id), amount: Number(wr.amount_cents) / 100 }, req);

    notifyUser(
      wr.user_id,
      `✅ <b>Withdrawal Processed!</b>\nYour withdrawal of <b>${(Number(wr.amount_cents) / 100).toFixed(2)} ETB</b> has been sent to your ${wr.account_method || 'account'}.`
    );

    res.json({ ok: true, withdrawalId: wId, status: 'approved' });
  } catch (err) {
    console.error('[POST /api/admin/withdraw/:id/approve]', err);
    res.status(500).json({ error: 'Failed to approve withdrawal.' });
  }
});

// POST /api/admin/withdraw/:id/reject
router.post('/api/admin/withdraw/:id/reject', requireAdmin, async (req, res) => {
  const wId = Number(req.params.id);
  const note = req.body.note || 'Rejected by administrator';
  try {
    const { rows } = await pool.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [wId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Withdrawal not found' });
    const wr = rows[0];
    if (wr.status !== 'pending') {
      return res.status(400).json({ error: `Cannot reject withdrawal with status: ${wr.status}` });
    }

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
         WHERE id = $3 AND status = 'pending'`,
        [String(refundLedgerId), note, wId]
      );
    });

    await writeAuditLog(req.adminId, 'withdrawal_reject', 'withdrawal_request', wId, { note, userId: String(wr.user_id), amount: Number(wr.amount_cents) / 100 }, req);

    notifyUser(
      wr.user_id,
      `❌ <b>Withdrawal Refunded</b>\nYour withdrawal request for <b>${(Number(wr.amount_cents) / 100).toFixed(2)} ETB</b> was rejected and refunded to your balance.\nReason: ${note}`
    );

    res.json({ ok: true, withdrawalId: wId, status: 'rejected' });
  } catch (err) {
    console.error('[POST /api/admin/withdraw/:id/reject]', err);
    res.status(500).json({ error: 'Failed to reject withdrawal.' });
  }
});

// POST /admin/game/pause
router.post('/admin/game/pause', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO game_config (key, value, updated_at) VALUES ('game_paused', 'true', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
    );
    await writeAuditLog(req.adminId, 'game_pause', 'game_config', 'game_paused', {}, req);
    res.json({ ok: true, paused: true });
  } catch (err) {
    console.error('[POST /admin/game/pause]', err);
    res.status(500).json({ error: 'Failed to pause game.' });
  }
});

// POST /admin/game/resume
router.post('/admin/game/resume', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO game_config (key, value, updated_at) VALUES ('game_paused', 'false', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW()`
    );
    await writeAuditLog(req.adminId, 'game_resume', 'game_config', 'game_paused', {}, req);
    res.json({ ok: true, paused: false });
  } catch (err) {
    console.error('[POST /admin/game/resume]', err);
    res.status(500).json({ error: 'Failed to resume game.' });
  }
});

// GET /api/admin/audit-log
router.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/admin/audit-log]', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// GET /admin — serve admin HTML dashboard
router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
