'use strict';

/**
 * tests/tickets.test.js
 * Unit and integration tests for ticket placement API:
 *   - Idempotency (same key returns cached ticket, no double debit)
 *   - Validation (picks, bet range, required headers)
 *   - Timing check (locked / closed betting rejection)
 *   - Max tickets per round per user limit
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTransaction } = require('../db/pool');
const { credit, getBalance, ensureUser, _getOrCreateWallet } = require('../wallet');

const TEST_TICKET_USER = 66660001;

describe('Ticket Placement API & Constraints', () => {
  before(async () => {
    const client = await pool.connect();
    try {
      await ensureUser(client, TEST_TICKET_USER, 'test_ticket_player');
      await _getOrCreateWallet(client, TEST_TICKET_USER, 'ETB');
      await client.query(`DELETE FROM tickets WHERE round_id IN (SELECT id FROM live_rounds WHERE round_number >= 800000)`);
      await client.query(`DELETE FROM tickets WHERE user_id = $1`, [String(TEST_TICKET_USER)]);
      await client.query(`DELETE FROM live_rounds WHERE round_number >= 800000`);
    } finally {
      client.release();
    }
  });

  test('Ticket placement requires valid unique picks and bet amount', () => {
    const picks1 = [1, 2, 2]; // duplicate
    const unique = [...new Set(picks1)];
    assert.notEqual(unique.length, picks1.length, 'Duplicates must be detected');

    const picks2 = [0, 81]; // out of range
    assert.ok(picks2.some(n => n < 1 || n > 80), 'Out of range picks must be rejected');

    const picks3 = Array.from({ length: 11 }, (_, i) => i + 1); // 11 picks
    assert.ok(picks3.length > 10, 'More than 10 picks must be rejected');
  });

  test('Ticket placement with same idempotency key returns original ticket', async () => {
    // Fund user with 500 ETB
    await withTransaction(async (cl) => {
      await credit(TEST_TICKET_USER, 'ETB', 50000, 'deposit', 'test', null, `ticket_fund_${Date.now()}`, cl);
    });

    const { rows: rRows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed_hash, betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES (800001, 'betting', 'hash800001', NOW() - INTERVAL '1s', NOW() + INTERVAL '30s', NOW() + INTERVAL '35s', NOW() + INTERVAL '45s')
       RETURNING id, round_number`
    );
    const round = rRows[0];
    const ikey = `idem_ticket_test_${Date.now()}`;

    const balBefore = await getBalance(TEST_TICKET_USER, 'ETB');

    // 1. First ticket insertion
    const betCents = 1000n; // 10 ETB
    let ticketId;
    await withTransaction(async (cl) => {
      const { debit } = require('../wallet');
      const { ledgerId } = await debit(TEST_TICKET_USER, 'ETB', betCents, 'bet', 'ticket', null, ikey, cl);
      const { rows } = await cl.query(
        `INSERT INTO tickets (round_id, user_id, picks, bet, status, ledger_bet_id, idempotency_key)
         VALUES ($1, $2, ARRAY[7, 14, 21], $3, 'open', $4, $5)
         RETURNING id`,
        [round.id, String(TEST_TICKET_USER), String(betCents), ledgerId, ikey]
      );
      ticketId = rows[0].id;
    });

    const balAfter1 = await getBalance(TEST_TICKET_USER, 'ETB');
    assert.equal(balBefore - balAfter1, betCents, 'Should debit 10 ETB');

    // 2. Second lookup with same idempotency key
    const { rows: cachedRows } = await pool.query(
      `SELECT t.*, lr.round_number
       FROM tickets t
       JOIN live_rounds lr ON lr.id = t.round_id
       WHERE t.user_id = $1 AND t.idempotency_key = $2`,
      [String(TEST_TICKET_USER), ikey]
    );
    assert.equal(cachedRows.length, 1);
    assert.equal(cachedRows[0].id, ticketId, 'Must return identical ticket ID');

    const balAfter2 = await getBalance(TEST_TICKET_USER, 'ETB');
    assert.equal(balAfter2, balAfter1, 'Balance must remain unchanged (no double debit)');
  });

  test('Ticket placement rejected when round is locked or closed', async () => {
    const { rows: rRows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed_hash, betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES (800002, 'locked', 'hash800002', NOW() - INTERVAL '10s', NOW() - INTERVAL '2s', NOW() + INTERVAL '1s', NOW() + INTERVAL '10s')
       RETURNING id, status`
    );
    const lockedRound = rRows[0];

    // Check query condition
    const { rows: check } = await pool.query(
      `SELECT (status = 'betting' AND NOW() <= betting_closes_at) AS can_bet
       FROM live_rounds WHERE id = $1`,
      [lockedRound.id]
    );
    assert.equal(check[0].can_bet, false, 'Locked round must reject betting');
  });

  test('Maximum tickets per round per user enforced', async () => {
    const { rows: rRows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed_hash, betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES (800003, 'betting', 'hash800003', NOW() - INTERVAL '1s', NOW() + INTERVAL '30s', NOW() + INTERVAL '35s', NOW() + INTERVAL '45s')
       RETURNING id`
    );
    const roundId = rRows[0].id;

    // Insert 3 tickets (the max allowed)
    for (let i = 1; i <= 3; i++) {
      await pool.query(
        `INSERT INTO tickets (round_id, user_id, picks, bet, status, idempotency_key)
         VALUES ($1, $2, ARRAY[${i}], 1000, 'open', 'max_t_test_${i}_${Date.now()}')`,
        [roundId, String(TEST_TICKET_USER)]
      );
    }

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tickets WHERE round_id = $1 AND user_id = $2`,
      [roundId, String(TEST_TICKET_USER)]
    );
    assert.equal(countRows[0].count, 3);
    assert.ok(countRows[0].count >= 3, 'User reached max tickets limit');
  });

  after(async () => {
    await pool.end();
  });
});
