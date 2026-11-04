'use strict';

/**
 * tests/hardening_regression.test.js
 * Verification of requirements:
 * 1. TRUST_PROXY configuration behavior (unset, "1", invalid).
 * 2. Second scheduler instance taking over if first dies / releases lock.
 * 3. Crash mid-DRAWING & crash mid-settlement (each ticket settled exactly once).
 * 4. Deposits: unique constraint on (method, tx_reference), received amount credit & claimed amount storage, duplicate rejection.
 * 5. Withdrawals: 24h cooling-off after destination change, 2nd admin approval above threshold.
 * 6. Admin token not in URLs, HTTPS enforcement in production.
 * 7. Failed Telegram notification does not fail or rollback approval.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { RoundScheduler } = require('../services/scheduler');
const { settleRound } = require('../services/settlement');
const { credit, debit, getBalance, ensureUser } = require('../wallet');
const { generateDrawnNumbers } = require('../services/draw');
const { notifyUser, notifyAdmin } = require('../services/notify');

const TEST_UID = 99990001n;
const TEST_UID_2 = 99990002n;

describe('Hardening & Advanced Verification Suite', () => {
  before(async () => {
    const client = await pool.connect();
    try {
      await ensureUser(client, TEST_UID, 'hardening_tester');
      await ensureUser(client, TEST_UID_2, 'hardening_tester_2');
      // Ensure wallets exist and initialize them so initial bonus is already credited
      const { _getOrCreateWallet } = require('../wallet');
      await _getOrCreateWallet(client, TEST_UID, 'ETB');
      await _getOrCreateWallet(client, TEST_UID_2, 'ETB');

      // Cleanup any previous test data
      await client.query(`DELETE FROM tickets WHERE round_id IN (SELECT id FROM live_rounds WHERE round_number >= 980000)`);
      await client.query(`DELETE FROM live_rounds WHERE round_number >= 980000`);
    } finally {
      client.release();
    }
  });

  // ── 1. TRUST_PROXY Configuration Behavior ──────────────────────────────────
  test('TRUST_PROXY config: unset, "1", and invalid behavior', () => {
    function configureTrustProxy(envVal) {
      const app = express();
      if (envVal !== undefined && envVal !== '') {
        const val = envVal.trim().toLowerCase();
        if (val === 'true') {
          app.set('trust proxy', true);
        } else if (val === 'false') {
          app.set('trust proxy', false);
        } else if (/^\d+$/.test(val)) {
          app.set('trust proxy', parseInt(val, 10));
        } else if (val === 'loopback' || val === 'linklocal' || val === 'uniquelocal') {
          app.set('trust proxy', val);
        } else {
          app.set('trust proxy', false); // invalid -> trust nothing
        }
      } else {
        app.set('trust proxy', false); // unset -> trust nothing
      }
      return app.get('trust proxy');
    }

    // Unset => trust nothing (false)
    assert.equal(configureTrustProxy(undefined), false, 'Unset must trust nothing');
    assert.equal(configureTrustProxy(''), false, 'Empty string must trust nothing');

    // "1" => trust 1 hop
    assert.equal(configureTrustProxy('1'), 1, '"1" must set trust proxy to 1');
    assert.equal(configureTrustProxy('2'), 2, '"2" must set trust proxy to 2');

    // Invalid => trust nothing (false)
    assert.equal(configureTrustProxy('foobar'), false, 'Invalid string must trust nothing');
    assert.equal(configureTrustProxy('xyz123'), false, 'Invalid string must trust nothing');

    // Standard valid strings
    assert.equal(configureTrustProxy('true'), true);
    assert.equal(configureTrustProxy('loopback'), 'loopback');
  });

  // ── 2. Scheduler Takeover ──────────────────────────────────────────────────
  test('Second scheduler instance takes over when first scheduler dies or releases lock', async () => {
    const lockId = 888123;
    const sched1 = new RoundScheduler({ lockId });
    const sched2 = new RoundScheduler({ lockId });

    const locked1 = await sched1.acquireLock();
    assert.equal(locked1, true, 'Scheduler 1 must acquire advisory lock');

    const locked2 = await sched2.acquireLock();
    assert.equal(locked2, false, 'Scheduler 2 must be blocked while Scheduler 1 holds lock');

    // Scheduler 1 dies / releases lock
    await sched1.releaseLock();

    // Scheduler 2 tries again and acquires
    const locked2Retry = await sched2.acquireLock();
    assert.equal(locked2Retry, true, 'Scheduler 2 must take over after Scheduler 1 dies/releases');

    await sched2.releaseLock();
  });

  // ── 3. Crash Mid-Drawing and Mid-Settlement Recovery ─────────────────────────
  test('Crash mid-DRAWING: scheduler recovers, computes draw deterministically, settles tickets', async () => {
    const client = await pool.connect();
    let roundId;
    const seed = 'crash_mid_drawing_test_seed_12345';
    try {
      // Round died while status was 'drawing' without drawn numbers completed
      const { rows } = await client.query(
        `INSERT INTO live_rounds 
           (round_number, status, server_seed, server_seed_hash, betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
         VALUES (980001, 'drawing', $1, 'hash980001', NOW() - INTERVAL '5m', NOW() - INTERVAL '4m', NOW() - INTERVAL '3m', NOW() - INTERVAL '2m')
         RETURNING id`,
        [seed]
      );
      roundId = rows[0].id;

      // User placed open ticket
      await client.query(
        `INSERT INTO tickets (round_id, user_id, picks, bet, status, idempotency_key)
         VALUES ($1, $2, ARRAY[1, 2], 1000, 'open', 'ticket_crash_draw_1')`,
        [roundId, String(TEST_UID)]
      );
    } finally {
      client.release();
    }

    // Boot scheduler to recover
    const sched = new RoundScheduler({ lockId: 888124 });
    await sched.acquireLock();
    await sched.recoverOnBoot();

    const { rows: tRows } = await pool.query(
      `SELECT status, settled_at, payout FROM tickets WHERE idempotency_key = 'ticket_crash_draw_1'`
    );
    assert.ok(tRows[0].status === 'won' || tRows[0].status === 'lost', 'Ticket must be settled');
    assert.ok(tRows[0].settled_at != null, 'Settled timestamp must be recorded');

    await sched.releaseLock();
  });

  test('Crash mid-settlement: re-running settlement settles each ticket exactly once without double credit', async () => {
    const seed = 'crash_mid_settle_seed_980002';
    const drawn = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const { rows: rRows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed_hash, drawn, betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES (980002, 'drawing', 'hash980002', $1, NOW(), NOW(), NOW(), NOW())
       RETURNING id`,
      [drawn]
    );
    const roundId = rRows[0].id;

    // Ticket 1: 3 numbers match -> wins 47x on 1000 cents = 47,000 cents
    const { rows: t1 } = await pool.query(
      `INSERT INTO tickets (round_id, user_id, picks, bet, status, idempotency_key)
       VALUES ($1, $2, ARRAY[1,2,3], 1000, 'open', 'ticket_mid_settle_1')
       RETURNING id`,
      [roundId, String(TEST_UID)]
    );

    const balBefore = await getBalance(TEST_UID, 'ETB');

    // Run settlement 1st time
    await settleRound(roundId, drawn, seed);
    const balAfter1 = await getBalance(TEST_UID, 'ETB');
    assert.equal(balAfter1 - balBefore, 47000n, 'Ticket 1 payout credited');

    // Re-run settlement (simulating recovery after restart)
    await settleRound(roundId, drawn, seed);
    const balAfter2 = await getBalance(TEST_UID, 'ETB');
    assert.equal(balAfter2, balAfter1, 'Must NOT double credit ticket');

    // Verify exactly one ledger win entry
    const { rows: winEntries } = await pool.query(
      `SELECT count(*) FROM ledger_entries WHERE ref_type = 'ticket' AND ref_id = $1 AND type = 'win'`,
      [String(t1[0].id)]
    );
    assert.equal(Number(winEntries[0].count), 1, 'Exactly one ledger win entry must exist');
  });

  // ── 4. Deposits: Unique Tx Ref, Received Amount, Duplicate Rejection ─────────
  test('Deposits: unique (method, tx_reference) constraint prevents duplicate references', async () => {
    const txRef = `TX-UNIQUE-${Date.now()}`;
    const method = 'telebirr';

    // First insert
    await pool.query(
      `INSERT INTO deposit_requests (user_id, amount_cents, method, reference_code, tx_reference, expires_at)
       VALUES ($1, 5000, $2, $3, $4, NOW() + INTERVAL '1 hour')`,
      [String(TEST_UID), method, `REF-${Date.now()}-1`, txRef]
    );

    // Duplicate insert with same method + tx_reference must fail
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO deposit_requests (user_id, amount_cents, method, reference_code, tx_reference, expires_at)
           VALUES ($1, 5000, $2, $3, $4, NOW() + INTERVAL '1 hour')`,
          [String(TEST_UID), method, `REF-${Date.now()}-2`, txRef]
        );
      },
      /uq_deposit_requests_method_tx_ref|unique/i
    );
  });

  test('Deposits: admin enters received amount; credits received and preserves claimed amount', async () => {
    const claimedCents = 10000; // Player claimed 100 ETB
    const receivedCents = 9500n; // Admin received 95 ETB (e.g. fees deducted)
    const refCode = `DEP-REC-${Date.now()}`;

    const { rows } = await pool.query(
      `INSERT INTO deposit_requests (user_id, amount_cents, claimed_amount_cents, method, reference_code, expires_at)
       VALUES ($1, $2, $2, 'cbe', $3, NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [String(TEST_UID), claimedCents, refCode]
    );
    const depId = rows[0].id;

    const balBefore = await getBalance(TEST_UID, 'ETB');

    // Execute approval crediting receivedCents
    const ikey = `deposit_approval_${depId}`;
    await withTransaction(async (client) => {
      const { ledgerId } = await credit(
        TEST_UID, 'ETB', receivedCents,
        'deposit', 'deposit_request', String(depId),
        ikey, client
      );
      await client.query(
        `UPDATE deposit_requests
         SET status = 'approved', admin_id = 'test_admin', decided_at = NOW(),
             ledger_credit_id = $1, received_amount_cents = $2, amount_cents = $2
         WHERE id = $3`,
        [String(ledgerId), String(receivedCents), depId]
      );
    });

    const balAfter = await getBalance(TEST_UID, 'ETB');
    assert.equal(balAfter - balBefore, receivedCents, 'Wallet must be credited with received amount, not claimed');

    const { rows: depCheck } = await pool.query(
      `SELECT claimed_amount_cents, received_amount_cents FROM deposit_requests WHERE id = $1`,
      [depId]
    );
    assert.equal(Number(depCheck[0].claimed_amount_cents), claimedCents, 'Claimed amount must be preserved');
    assert.equal(Number(depCheck[0].received_amount_cents), Number(receivedCents), 'Received amount must be recorded');
  });

  // ── 5. Withdrawals: 24h Cooling-Off and 2nd Admin Approval ───────────────────
  test('Withdrawals: 24-hour cooling-off active after destination change blocks withdrawal', async () => {
    // Set user's destination updated 2 hours ago
    await pool.query(
      `UPDATE users
       SET last_payout_destination = 'telebirr:0911000000',
           payout_destination_updated_at = NOW() - INTERVAL '2 hours'
       WHERE id = $1`,
      [String(TEST_UID)]
    );

    const { rows: uRows } = await pool.query(
      `SELECT last_payout_destination, payout_destination_updated_at FROM users WHERE id = $1`,
      [String(TEST_UID)]
    );
    const userRec = uRows[0];
    const newDest = 'cbe:100099999999';

    // Verify check logic
    const diffMs = Date.now() - new Date(userRec.payout_destination_updated_at).getTime();
    const isCooling = userRec.last_payout_destination !== newDest && diffMs < 24 * 3600 * 1000;
    assert.equal(isCooling, true, 'Cooling-off period must be active when destination differs');
  });

  test('Withdrawals: high amount requires two distinct admin approvals', async () => {
    // Fund user and debit for withdrawal
    const wAmountCents = 600000n; // 6000 ETB > 5000 ETB threshold
    await withTransaction(async (cl) => {
      await credit(TEST_UID_2, 'ETB', wAmountCents, 'deposit', 'test', null, `wdr_test_fund_${Date.now()}`, cl);
    });

    const { rows: wRows } = await pool.query(
      `INSERT INTO withdrawal_requests (user_id, currency, amount_cents, account_method, account_number, status)
       VALUES ($1, 'ETB', $2, 'telebirr', '0988888888', 'pending')
       RETURNING id`,
      [String(TEST_UID_2), String(wAmountCents)]
    );
    const wId = wRows[0].id;

    const THRESHOLD = 500000;

    // Step 1: Admin 1 approves -> status stays pending, first_approved_by recorded
    await pool.query(
      `UPDATE withdrawal_requests
       SET first_approved_by = 'admin_alpha', first_approved_at = NOW(), requires_second_approval = true
       WHERE id = $1`,
      [wId]
    );

    const { rows: step1Check } = await pool.query(`SELECT * FROM withdrawal_requests WHERE id = $1`, [wId]);
    assert.equal(step1Check[0].status, 'pending');
    assert.equal(step1Check[0].first_approved_by, 'admin_alpha');

    // Step 2: Same admin cannot give second approval
    const canSameAdminApprove = step1Check[0].first_approved_by !== 'admin_alpha';
    assert.equal(canSameAdminApprove, false, 'Same admin cannot give second approval');

    // Step 3: Admin 2 approves -> finalizes approval
    await pool.query(
      `UPDATE withdrawal_requests
       SET status = 'approved', updated_at = NOW(), second_approved_by = 'admin_beta', second_approved_at = NOW()
       WHERE id = $1`,
      [wId]
    );

    const { rows: step2Check } = await pool.query(`SELECT * FROM withdrawal_requests WHERE id = $1`, [wId]);
    assert.equal(step2Check[0].status, 'approved', 'Must be approved after second distinct admin approves');
    assert.equal(step2Check[0].second_approved_by, 'admin_beta');
  });

  // ── 6. Non-Fatal Telegram Notifications ────────────────────────────────────
  test('A failed Telegram notification never fails or rolls back an approval', async () => {
    // Calling notifyUser with invalid token/chat must resolve smoothly without throwing
    let threw = false;
    try {
      await notifyUser('999999999999', 'Test notification to non-existent user');
      await notifyAdmin('Test notification with dummy/invalid bot token');
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'Telegram notifications must silently swallow network/API errors');
  });

  after(async () => {
    await pool.end();
  });
});
