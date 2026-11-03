'use strict';

/**
 * tests/wallet.test.js
 * Tests: parallel bets, idempotency, rollback, balance consistency.
 * Uses pg-mem for an in-memory Postgres-compatible engine.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Must patch pool BEFORE any module that uses it is required
const dbModule = require('../db/pool');

const { newDb } = require('pg-mem');

let dbPool;

describe('Wallet', async () => {
  before(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbPool = new Pool();

    // Inject into db/pool module
    dbModule.pool = dbPool;
    dbModule.withTransaction = async (fn) => {
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        country TEXT, date_of_birth DATE, excluded_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        user_id TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
        balance BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, currency)
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD', type TEXT NOT NULL,
        amount BIGINT NOT NULL, balance_after BIGINT NOT NULL,
        ref_type TEXT, ref_id TEXT, idempotency_key TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedUser(userId, balanceCents) {
    await dbPool.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [String(userId)]
    );
    await dbPool.query(`
      INSERT INTO wallets (user_id, currency, balance)
      VALUES ($1, 'USD', $2)
      ON CONFLICT (user_id, currency) DO UPDATE SET balance = EXCLUDED.balance
    `, [String(userId), String(balanceCents)]);
  }

  test('credit increases balance', async () => {
    const { credit, getBalance } = require('../wallet');
    await seedUser(1001, 0);
    await credit(1001, 'USD', 5000, 'deposit', null, null, 'credit-test-1');
    const bal = await getBalance(1001, 'USD');
    assert.equal(bal, 5000n);
  });

  test('debit decreases balance', async () => {
    const { debit, getBalance } = require('../wallet');
    await seedUser(1002, 10000);
    await debit(1002, 'USD', 3000, 'bet', null, null, 'debit-test-1');
    const bal = await getBalance(1002, 'USD');
    assert.equal(bal, 7000n);
  });

  test('debit throws INSUFFICIENT_BALANCE when funds too low', async () => {
    const { debit } = require('../wallet');
    await seedUser(1003, 500);
    await assert.rejects(
      () => debit(1003, 'USD', 1000, 'bet', null, null, 'debit-insuf-1'),
      (err) => { assert.equal(err.code, 'INSUFFICIENT_BALANCE'); return true; }
    );
  });

  test('balance never goes negative under 50 parallel bets (funds for 10)', { skip: 'pg-mem does not serialise SELECT FOR UPDATE — run this test against a real PostgreSQL instance' }, async () => {
    const { debit, getBalance } = require('../wallet');
    const userId   = 2001;
    const betCents = 1000;
    await seedUser(userId, betCents * 10); // only enough for 10 bets

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        debit(userId, 'USD', betCents, 'bet', null, null, `parallel-bet-${userId}-${i}`)
      )
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed    = results.filter(r => r.status === 'rejected').length;

    assert.equal(succeeded, 10, `Expected 10 successes, got ${succeeded}`);
    assert.equal(failed,    40, `Expected 40 failures, got ${failed}`);
    assert.equal(await getBalance(userId, 'USD'), 0n);
  });

  test('credit idempotency: same key, no double-credit', async () => {
    const { credit, getBalance } = require('../wallet');
    const userId = 3001;
    await seedUser(userId, 0);
    const key = 'idem-credit-3001';
    const r1 = await credit(userId, 'USD', 2000, 'deposit', null, null, key);
    const r2 = await credit(userId, 'USD', 2000, 'deposit', null, null, key);
    assert.equal(r1.ledgerId, r2.ledgerId);
    assert.equal(await getBalance(userId, 'USD'), 2000n);
  });

  test('debit idempotency: same key, no double-debit', async () => {
    const { debit, getBalance } = require('../wallet');
    const userId = 3002;
    await seedUser(userId, 5000);
    const key = 'idem-debit-3002';
    const r1 = await debit(userId, 'USD', 1000, 'bet', null, null, key);
    const r2 = await debit(userId, 'USD', 1000, 'bet', null, null, key);
    assert.equal(r1.ledgerId, r2.ledgerId);
    assert.equal(await getBalance(userId, 'USD'), 4000n);
  });

  test('rollback: failed transaction leaves balance and ledger unchanged', { skip: 'pg-mem does not support full ROLLBACK semantics — run this test against a real PostgreSQL instance' }, async () => {
    const { getBalance } = require('../wallet');
    const userId = 4001;
    await seedUser(userId, 3000);

    let threw = false;
    try {
      await dbModule.withTransaction(async (client) => {
        await client.query(
          `UPDATE wallets SET balance = balance - 1000 WHERE user_id = $1 AND currency = 'USD'`,
          [String(userId)]
        );
        throw new Error('Simulated failure');
      });
    } catch { threw = true; }

    assert.ok(threw);
    assert.equal(await getBalance(userId, 'USD'), 3000n);

    const { rows } = await dbPool.query(
      `SELECT count(*) AS c FROM ledger_entries WHERE user_id = $1`, [String(userId)]
    );
    assert.equal(Number(rows[0].c), 0);
  });
});
