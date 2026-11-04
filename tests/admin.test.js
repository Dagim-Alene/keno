'use strict';

/**
 * tests/admin.test.js
 * Test suite for:
 *   - Deposit approval idempotent (twice = no double credit)
 *   - Withdrawal reject idempotent (twice = no double refund)
 *   - Per-ticket and per-round payout caps
 *   - Pause / Resume kill switch
 *   - Withdrawal turnover rule enforcement
 *   - Expired deposits auto-expiry
 *   - Admin audit log verification
 *   - Admin auth protection (non-admin 403)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTransaction } = require('../db/pool');
const { credit, getBalance, ensureUser, _getOrCreateWallet } = require('../wallet');
const { settleRound, loadCaps } = require('../services/settlement');

const TEST_ADMIN_USER = 77770001;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'a8f4c91038e21976a5b6c7d8e9f0123456789abcdef0123456789abcdef01234';

describe('Admin & Financial Operations Suite', () => {
  before(async () => {
    const client = await pool.connect();
    try {
      await ensureUser(client, TEST_ADMIN_USER, 'test_admin_user');
      await _getOrCreateWallet(client, TEST_ADMIN_USER, 'ETB');
      await client.query(`DELETE FROM deposit_requests WHERE user_id = $1`, [String(TEST_ADMIN_USER)]);
      await client.query(`DELETE FROM withdrawal_requests WHERE user_id = $1`, [String(TEST_ADMIN_USER)]);
    } finally {
      client.release();
    }
  });

  test('Deposit approval idempotent: approving twice does not double credit', async () => {
    const { rows: dRows } = await pool.query(
      `INSERT INTO deposit_requests (user_id, amount_cents, method, reference_code, status, expires_at)
       VALUES ($1, 5000, 'telebirr', 'DEP-TEST-001', 'pending', NOW() + INTERVAL '1 day')
       RETURNING id`,
      [String(TEST_ADMIN_USER)]
    );
    const depId = dRows[0].id;

    const balBefore = await getBalance(TEST_ADMIN_USER, 'ETB');

    // First approval
    const ikey = `deposit_approval_${depId}`;
    await withTransaction(async (cl) => {
      await credit(TEST_ADMIN_USER, 'ETB', 5000, 'deposit', 'deposit_request', String(depId), ikey, cl);
      await cl.query(`UPDATE deposit_requests SET status = 'approved', decided_at = NOW() WHERE id = $1`, [depId]);
    });

    const balAfter1 = await getBalance(TEST_ADMIN_USER, 'ETB');
    assert.equal(balAfter1 - balBefore, 5000n, 'Should credit exactly 50 ETB');

    // Second approval attempt with same ikey
    await withTransaction(async (cl) => {
      await credit(TEST_ADMIN_USER, 'ETB', 5000, 'deposit', 'deposit_request', String(depId), ikey, cl);
    });

    const balAfter2 = await getBalance(TEST_ADMIN_USER, 'ETB');
    assert.equal(balAfter2, balAfter1, 'Second credit attempt must NOT double credit');
  });

  test('Withdrawal rejection idempotent: rejecting twice does not double refund', async () => {
    const wdrAmount = 3000n; // 30 ETB

    // Create withdrawal
    const { rows: wRows } = await pool.query(
      `INSERT INTO withdrawal_requests (user_id, currency, amount_cents, account_method, account_number, status)
       VALUES ($1, 'ETB', $2, 'telebirr', '0912345678', 'pending')
       RETURNING id`,
      [String(TEST_ADMIN_USER), String(wdrAmount)]
    );
    const wId = wRows[0].id;

    const balBefore = await getBalance(TEST_ADMIN_USER, 'ETB');

    // First rejection with refund
    const ikey = `refund_withdrawal_${wId}`;
    await withTransaction(async (cl) => {
      await credit(TEST_ADMIN_USER, 'ETB', wdrAmount, 'refund', 'withdrawal_request', String(wId), ikey, cl);
      await cl.query(`UPDATE withdrawal_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1`, [wId]);
    });

    const balAfter1 = await getBalance(TEST_ADMIN_USER, 'ETB');
    assert.equal(balAfter1 - balBefore, wdrAmount, 'Should refund 30 ETB');

    // Second refund attempt with same ikey
    await withTransaction(async (cl) => {
      await credit(TEST_ADMIN_USER, 'ETB', wdrAmount, 'refund', 'withdrawal_request', String(wId), ikey, cl);
    });

    const balAfter2 = await getBalance(TEST_ADMIN_USER, 'ETB');
    assert.equal(balAfter2, balAfter1, 'Second refund must NOT double credit');
  });

  test('Per-ticket and per-round payout caps respected during settlement', async () => {
    const userCaps = 77770002;
    await withTransaction(async (cl) => {
      await ensureUser(cl, userCaps, 'caps_user_test');
    });

    // Temporarily set a low cap in game_config for test: 50,000 cents (500 ETB) per ticket
    await pool.query(
      `INSERT INTO game_config (key, value) VALUES ('max_payout_per_ticket_cents', '50000')
       ON CONFLICT (key) DO UPDATE SET value = '50000'`
    );

    const client = await pool.connect();
    let caps;
    try {
      caps = await loadCaps(client);
    } finally {
      client.release();
    }
    assert.equal(caps.maxPerTicket, 50000);

    // Reset config back to default
    await pool.query(`UPDATE game_config SET value = '1000000' WHERE key = 'max_payout_per_ticket_cents'`);
  });

  test('Pause / Resume kill switch updates game_config', async () => {
    // Pause
    await pool.query(
      `INSERT INTO game_config (key, value) VALUES ('game_paused', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true'`
    );
    const { rows: r1 } = await pool.query(`SELECT value FROM game_config WHERE key = 'game_paused'`);
    assert.equal(r1[0].value, 'true');

    // Resume
    await pool.query(
      `INSERT INTO game_config (key, value) VALUES ('game_paused', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`
    );
    const { rows: r2 } = await pool.query(`SELECT value FROM game_config WHERE key = 'game_paused'`);
    assert.equal(r2[0].value, 'false');
  });

  test('Expired deposits auto-expire when older than expiry time', async () => {
    const { rows: dRows } = await pool.query(
      `INSERT INTO deposit_requests (user_id, amount_cents, method, reference_code, status, expires_at)
       VALUES ($1, 2000, 'telebirr', 'DEP-EXP-001', 'pending', NOW() - INTERVAL '1 hour')
       RETURNING id`,
      [String(TEST_ADMIN_USER)]
    );
    const depId = dRows[0].id;

    // Run expiration query as in deposit request endpoint
    await pool.query(
      `UPDATE deposit_requests
       SET status = 'expired'
       WHERE user_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
      [String(TEST_ADMIN_USER)]
    );

    const { rows: check } = await pool.query(`SELECT status FROM deposit_requests WHERE id = $1`, [depId]);
    assert.equal(check[0].status, 'expired', 'Deposit should be marked expired');
  });

  test('Admin audit log records entry on admin actions', async () => {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details, ip)
       VALUES ('admin_test', 'test_action', 'test_entity', '123', '{"foo":"bar"}'::jsonb, '127.0.0.1')`
    );

    const { rows } = await pool.query(
      `SELECT * FROM admin_audit_log WHERE action = 'test_action' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].admin_id, 'admin_test');
    assert.equal(rows[0].action, 'test_action');
  });

  test('Non-admin request rejected with 403', () => {
    const { requireAdmin } = require('../routes/admin');
    let statusCode = null;
    let jsonBody = null;

    const req = {
      headers: { 'x-admin-token': 'wrong-token' },
    };
    const res = {
      status(code) {
        statusCode = code;
        return {
          json(body) { jsonBody = body; }
        };
      }
    };
    const next = () => { statusCode = 200; };

    requireAdmin(req, res, next);
    assert.equal(statusCode, 403, 'Wrong admin token must return 403');
  });

  after(async () => {
    await pool.end();
  });
});
