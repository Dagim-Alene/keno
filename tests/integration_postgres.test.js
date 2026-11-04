'use strict';

/**
 * tests/integration_postgres.test.js
 * Integration tests against real PostgreSQL database.
 * Verifies row locking (50 parallel bets with funds for 10),
 * full transaction rollback semantics, and append-only trigger enforcement.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const { pool, withTransaction } = require('../db/pool');
const { credit, debit, getBalance, ensureUser, _getOrCreateWallet } = require('../wallet');

describe('PostgreSQL Real Integration Tests', async () => {
  test('50 parallel bets on a wallet with funds for only 10 must succeed exactly 10 times and never go negative', async () => {
    const runId = Date.now();
    const userId = BigInt(`8881${String(runId).slice(-6)}`);
    // Each user starts with INITIAL_BALANCE_CENTS = 100,000 cents ($1,000)
    // A bet of 10,000 cents ($100) means there are funds for EXACTLY 10 bets
    const betCents = 10000n;

    const client = await pool.connect();
    try {
      await ensureUser(client, userId, `concurrency_user_${runId}`);
      await _getOrCreateWallet(client, userId, 'USD');
    } finally {
      client.release();
    }

    const startBalance = await getBalance(userId, 'USD');
    assert.equal(startBalance, 100000n, 'Starting balance must be 100,000 cents');

    // Fire 50 simultaneous debit calls
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        debit(userId, 'USD', betCents, 'bet', 'keno_round', `sim_${i}`, `concurrency_bet_${runId}_${i}`)
      )
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(succeeded.length, 10, `Expected exactly 10 bets to succeed, got ${succeeded.length}`);
    assert.equal(rejected.length, 40, `Expected exactly 40 bets to fail, got ${rejected.length}`);

    // Verify all rejections are INSUFFICIENT_BALANCE
    for (const r of rejected) {
      assert.equal(r.reason.code, 'INSUFFICIENT_BALANCE');
    }

    // Balance must be exactly 0
    const finalBalance = await getBalance(userId, 'USD');
    assert.equal(finalBalance, 0n, 'Final balance must be exactly 0');
  });

  test('Rollback on failed transaction leaves balance and ledger unchanged', async () => {
    const runId = Date.now();
    const userId = BigInt(`8882${String(runId).slice(-6)}`);

    const client = await pool.connect();
    try {
      await ensureUser(client, userId, `rollback_user_${runId}`);
      await _getOrCreateWallet(client, userId, 'USD');
    } finally {
      client.release();
    }

    const startBalance = await getBalance(userId, 'USD');
    const initialEntriesRes = await pool.query(
      'SELECT count(*) FROM ledger_entries WHERE user_id = $1',
      [String(userId)]
    );
    const initialEntriesCount = Number(initialEntriesRes.rows[0].count);

    // Run a transaction that debits then intentionally throws
    await assert.rejects(
      async () => {
        await withTransaction(async (txClient) => {
          await debit(userId, 'USD', 10000n, 'bet', null, null, `rollback_key_${runId}`, txClient);
          throw new Error('Simulated game engine error triggering rollback');
        });
      },
      /Simulated game engine error/
    );

    // Verify balance is unchanged
    const currentBalance = await getBalance(userId, 'USD');
    assert.equal(currentBalance, startBalance, 'Balance must remain unchanged after rollback');

    // Verify no new ledger entries were committed
    const finalEntriesRes = await pool.query(
      'SELECT count(*) FROM ledger_entries WHERE user_id = $1',
      [String(userId)]
    );
    assert.equal(Number(finalEntriesRes.rows[0].count), initialEntriesCount, 'Ledger entries count must be unchanged');
  });

  test('Ledger append-only trigger blocks UPDATE on existing entries', async () => {
    const runId = Date.now();
    const userId = BigInt(`8883${String(runId).slice(-6)}`);
    const client = await pool.connect();
    let entryId;
    try {
      await ensureUser(client, userId, `trigger_test_user_${runId}`);
      const { ledgerId } = await credit(userId, 'USD', 5000n, 'deposit', null, null, `trigger_test_key_${runId}`);
      entryId = ledgerId;
    } finally {
      client.release();
    }

    // Attempt to illegally modify the ledger entry amount
    await assert.rejects(
      async () => {
        await pool.query(
          'UPDATE ledger_entries SET amount = 999999 WHERE id = $1',
          [String(entryId)]
        );
      },
      /ledger_entries is append-only/
    );
  });

  test('Ledger append-only trigger blocks DELETE on existing entries', async () => {
    const runId = Date.now();
    const userId = BigInt(`8884${String(runId).slice(-6)}`);
    let entryId;
    const client = await pool.connect();
    try {
      await ensureUser(client, userId, `trigger_delete_user_${runId}`);
      const { ledgerId } = await credit(userId, 'USD', 2000n, 'deposit', null, null, `trigger_del_key_${runId}`);
      entryId = ledgerId;
    } finally {
      client.release();
    }

    // Attempt to illegally delete the ledger entry
    await assert.rejects(
      async () => {
        await pool.query(
          'DELETE FROM ledger_entries WHERE id = $1',
          [String(entryId)]
        );
      },
      /ledger_entries is append-only/
    );
  });

  after(async () => {
    await pool.end();
  });
});
