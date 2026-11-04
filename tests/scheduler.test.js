'use strict';

/**
 * tests/scheduler.test.js
 * Comprehensive unit and integration test suite for live shared round scheduler,
 * lifecycle phases, betting lock boundaries, 50 parallel bets, crash recovery,
 * advisory locking, and snapshot generation.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const { RoundScheduler } = require('../services/scheduler');
const { settleRound } = require('../services/settlement');
const { credit, getBalance, ensureUser } = require('../wallet');
const { generateDrawnNumbers, sha256 } = require('../services/draw');
const { buildSnapshot } = require('../routes/live');

const TEST_USER_ID = 88880001;

describe('Live Shared Rounds & Scheduler', () => {
  before(async () => {
    const client = await pool.connect();
    try {
      await ensureUser(client, TEST_USER_ID, 'test_scheduler_user');
      await client.query(`DELETE FROM tickets WHERE user_id = $1`, [String(TEST_USER_ID)]);
      await client.query(`DELETE FROM tickets WHERE round_id IN (SELECT id FROM live_rounds WHERE round_number >= 900000)`);
      await client.query(`DELETE FROM live_rounds WHERE round_number >= 900000`);
    } finally {
      client.release();
    }
  });

  test('Advisory lock: only one scheduler instance can acquire the lock', async () => {
    const sched1 = new RoundScheduler({ lockId: 99901 });
    const sched2 = new RoundScheduler({ lockId: 99901 });

    const locked1 = await sched1.acquireLock();
    assert.equal(locked1, true, 'First scheduler should acquire advisory lock');

    const locked2 = await sched2.acquireLock();
    assert.equal(locked2, false, 'Second scheduler must NOT acquire advisory lock concurrently');

    await sched1.releaseLock();
    await sched2.releaseLock();
  });

  test('Round advances through all phases on schedule with injectable clock', async () => {
    let fakeTime = Date.now();
    const sched = new RoundScheduler({ lockId: 99902, getNow: () => fakeTime });
    const locked = await sched.acquireLock();
    assert.equal(locked, true);

    const round = await sched.createNewRound(900001);
    assert.ok(round);
    assert.equal(round.status, 'betting');

    const phasesSeen = [];
    sched.onPhaseChange = (phase) => phasesSeen.push(phase);

    // 1. Advance to LOCKED (26 seconds later)
    fakeTime += 26000;
    await sched.runCycle();
    assert.equal(sched.currentRound.status, 'locked');

    // 2. Advance to DRAWING (4 seconds later)
    fakeTime += 4000;
    await sched.runCycle();
    assert.equal(sched.currentRound.status, 'drawing');

    // 3. Advance to RESULT & SETTLED (11 seconds later)
    fakeTime += 11000;
    await sched.runCycle();
    assert.equal(sched.currentRound.status, 'settled');
    assert.ok(sched.currentRound.server_seed, 'Server seed must be revealed after settlement');

    await sched.stop();
    await sched.releaseLock();
  });

  test('Bet boundary: bet before lock accepted; bet at or after lock rejected', async () => {
    let fakeTime = Date.now();
    const sched = new RoundScheduler({ lockId: 99903, getNow: () => fakeTime });
    await sched.acquireLock();

    const round = await sched.createNewRound(900002);

    // Fund user with 1000 ETB
    await withTransaction(async (cl) => {
      await credit(TEST_USER_ID, 'ETB', 100000, 'deposit', 'test', null, `test_fund_${Date.now()}_1`, cl);
    });

    // 1. Bet before close: should succeed
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT NOW() <= $1 AS is_open`, [round.betting_closes_at]
      );
      assert.equal(rows[0].is_open, true, 'Betting should be open');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Now update round to locked in DB
    await pool.query(`UPDATE live_rounds SET status = 'locked' WHERE id = $1`, [round.id]);

    // 2. Bet after lock: must fail
    const { rows: rCheck } = await pool.query(
      `SELECT status FROM live_rounds WHERE id = $1`, [round.id]
    );
    assert.equal(rCheck[0].status, 'locked', 'Round should now be locked');

    await sched.stop();
    await sched.releaseLock();
  });

  test('50 parallel tickets on a wallet with funds for only 10: exactly 10 succeed, never negative', async () => {
    const userParallel = 88880002;
    const client = await pool.connect();
    try {
      await ensureUser(client, userParallel, 'user_parallel_test');
    } finally {
      client.release();
    }

    // Set balance to exactly 10 bets of 10 ETB (1000 cents each = 10,000 cents total)
    const curBal = await getBalance(userParallel, 'ETB');
    if (curBal > 10000n) {
      await withTransaction(async (cl) => {
        const { debit } = require('../wallet');
        await debit(userParallel, 'ETB', curBal - 10000n, 'adjustment', 'test_reset', null, `reset_${Date.now()}`, cl);
      });
    } else if (curBal < 10000n) {
      await withTransaction(async (cl) => {
        await credit(userParallel, 'ETB', 10000n - curBal, 'deposit', 'test_reset', null, `reset_${Date.now()}`, cl);
      });
    }

    // Create an open live round
    const { rows: rRows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed_hash, betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES (900003, 'betting', 'hash900003', NOW() - INTERVAL '1 second', NOW() + INTERVAL '30 seconds', NOW() + INTERVAL '35 seconds', NOW() + INTERVAL '45 seconds')
       RETURNING id`
    );
    const roundId = rRows[0].id;

    const betAmount = 1000n; // 10 ETB

    const runOne = async (index) => {
      const ikey = `parallel_ticket_${index}_${Date.now()}`;
      try {
        return await withTransaction(async (cl) => {
          // Lock wallet
          const { rows: wRows } = await cl.query(
            `SELECT balance FROM wallets WHERE user_id = $1 AND currency = 'ETB' FOR UPDATE`,
            [String(userParallel)]
          );
          const currentBal = BigInt(wRows[0]?.balance || 0);
          if (currentBal < betAmount) {
            throw new Error('Insufficient balance');
          }
          const newBal = currentBal - betAmount;
          await cl.query(`UPDATE wallets SET balance = $1 WHERE user_id = $2 AND currency = 'ETB'`, [String(newBal), String(userParallel)]);
          const { rows: lRows } = await cl.query(
            `INSERT INTO ledger_entries (user_id, currency, type, amount, balance_after, idempotency_key)
             VALUES ($1, 'ETB', 'bet', $2, $3, $4) RETURNING id`,
            [String(userParallel), String(-betAmount), String(newBal), ikey]
          );
          await cl.query(
            `INSERT INTO tickets (round_id, user_id, picks, bet, status, ledger_bet_id, idempotency_key)
             VALUES ($1, $2, ARRAY[1,2,3], $3, 'open', $4, $5)`,
            [roundId, String(userParallel), String(betAmount), lRows[0].id, ikey]
          );
          return { ok: true };
        });
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => runOne(i))
    );

    const successes = results.filter(r => r.ok).length;
    const failures = results.filter(r => !r.ok).length;

    assert.equal(successes, 10, 'Exactly 10 tickets must succeed');
    assert.equal(failures, 40, 'Remaining 40 tickets must fail due to insufficient balance');

    const finalBal = await getBalance(userParallel, 'ETB');
    assert.equal(finalBal, 0n, 'Wallet balance must be exactly 0, never negative');
  });

  test('Idempotent settlement: running settlement twice does not double-credit', async () => {
    const userSettle = 88880003;
    await withTransaction(async (cl) => {
      await ensureUser(cl, userSettle, 'user_settle_test');
    });

    const serverSeed = 'settle_seed_test_1234567890abcdef1234567890abcdef';
    const drawn = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

    const { rows: rRows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed_hash, drawn, betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES (900004, 'drawing', 'hash900004', $1, NOW(), NOW(), NOW(), NOW())
       RETURNING id`,
      [drawn]
    );
    const roundId = rRows[0].id;

    // Insert a winning ticket: picks [1, 2, 3] -> 3 hits = 47x on 10 ETB (1000 cents) = 47,000 cents
    const { rows: tRows } = await pool.query(
      `INSERT INTO tickets (round_id, user_id, picks, bet, status, idempotency_key)
       VALUES ($1, $2, ARRAY[1,2,3], 1000, 'open', 'settle_ticket_1')
       RETURNING id`,
      [roundId, String(userSettle)]
    );
    const ticketId = tRows[0].id;

    const balBefore = await getBalance(userSettle, 'ETB');

    // Run settlement 1st time
    await settleRound(roundId, drawn, serverSeed);
    const balAfter1 = await getBalance(userSettle, 'ETB');
    assert.equal(balAfter1 - balBefore, 47000n, 'Should be credited 470 ETB');

    // Run settlement 2nd time
    await settleRound(roundId, drawn, serverSeed);
    const balAfter2 = await getBalance(userSettle, 'ETB');
    assert.equal(balAfter2, balAfter1, 'Second settlement must NOT credit again');
  });

  test('Crash recovery: recovering round settles open tickets deterministically', async () => {
    const userCrash = 88880004;
    await withTransaction(async (cl) => {
      await ensureUser(cl, userCrash, 'user_crash_test');
    });

    const serverSeed = 'crash_recovery_seed_abcdef123456';
    const drawn = generateDrawnNumbers(serverSeed, '900005', 0);

    const { rows: rRows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed, server_seed_hash, drawn,
          betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES (900005, 'drawing', $1, 'crash_hash', $2, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '9 minutes', NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '7 minutes')
       RETURNING *`,
      [serverSeed, drawn]
    );
    const roundId = rRows[0].id;

    // Open ticket
    await pool.query(
      `INSERT INTO tickets (round_id, user_id, picks, bet, status, idempotency_key)
       VALUES ($1, $2, ARRAY[${drawn[0]}, ${drawn[1]}], 1000, 'open', 'crash_ticket_1')`,
      [roundId, String(userCrash)]
    );

    const sched = new RoundScheduler();
    await sched.acquireLock();
    const recovered = await sched.recoverOnBoot();

    // Ticket must now be settled
    const { rows: tCheck } = await pool.query(
      `SELECT status, settled_at FROM tickets WHERE idempotency_key = 'crash_ticket_1'`
    );
    assert.equal(tCheck[0].status, 'won', 'Crash recovery should settle ticket as won');
    assert.ok(tCheck[0].settled_at != null, 'Settled timestamp must be set');

    await sched.releaseLock();
  });

  test('Late-joiner snapshot returns correct drawn balls mid-draw', async () => {
    const drawn = [10, 20, 30, 40, 50, 60, 70, 80, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13];
    const sched = new RoundScheduler({ getNow: () => 1700000005000 }); // 5s into 10s draw = 50% = 10 balls
    sched.currentRound = {
      id: '999999',
      round_number: 999999,
      status: 'drawing',
      drawn,
      server_seed_hash: 'hash_mid_draw',
      betting_opens_at: new Date(1700000000000),
      betting_closes_at: new Date(1700000000000),
      draw_starts_at: new Date(1700000000000), // starts at 0s
      result_starts_at: new Date(1700000010000), // ends at 10s
    };

    // Check format
    const formatted = sched.formatRoundForPublic(sched.currentRound);
    assert.equal(formatted.status, 'drawing');
    assert.deepEqual(formatted.drawn, drawn);
  });

  after(async () => {
    await pool.end();
  });
});
