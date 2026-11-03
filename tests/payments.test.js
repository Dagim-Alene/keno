'use strict';

/**
 * tests/payments.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Patch pool first
const dbModule = require('../db/pool');
const { newDb } = require('pg-mem');

let dbPool;

describe('Payments', async () => {
  before(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbPool = new Pool();
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
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        country TEXT, date_of_birth DATE, excluded_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbPool.query(`
      CREATE TABLE wallets (
        user_id TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
        balance BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, currency)
      )
    `);
    await dbPool.query(`
      CREATE TABLE ledger_entries (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD', type TEXT NOT NULL,
        amount BIGINT NOT NULL, balance_after BIGINT NOT NULL,
        ref_type TEXT, ref_id TEXT, idempotency_key TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbPool.query(`
      CREATE TABLE withdrawal_requests (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD', amount_cents BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        ledger_debit_id BIGINT, ledger_refund_id BIGINT, admin_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  after(async () => { if (dbPool) await dbPool.end(); });

  async function seedUser(id, balanceCents) {
    await dbPool.query(`INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [String(id)]);
    await dbPool.query(`
      INSERT INTO wallets (user_id, currency, balance)
      VALUES ($1, 'USD', $2)
      ON CONFLICT (user_id, currency) DO UPDATE SET balance = EXCLUDED.balance
    `, [String(id), String(balanceCents)]);
  }

  test('createDeposit returns paymentId and redirectUrl', async () => {
    const provider = require('../payments/provider');
    const result = await provider.createDeposit(9001, 5000, 'USD');
    assert.ok(result.paymentId);
    assert.ok(result.redirectUrl);
  });

  test('verifyWebhookSignature: valid', () => {
    const provider = require('../payments/provider');
    const secret = process.env.PAYMENT_WEBHOOK_SECRET || 'dev-secret';
    const body = Buffer.from(JSON.stringify({ test: 1 }));
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.ok(provider.verifyWebhookSignature(body, sig));
  });

  test('verifyWebhookSignature: tampered → false', () => {
    const provider = require('../payments/provider');
    const body = Buffer.from(JSON.stringify({ test: 1 }));
    assert.ok(!provider.verifyWebhookSignature(body, 'badhash'));
  });

  test('webhook credit is idempotent', async () => {
    const { credit, getBalance } = require('../wallet');
    await seedUser(9002, 0);
    const key = 'webhook_payment_abc123';
    await credit(9002, 'USD', 10000, 'deposit', 'payment', 'abc123', key);
    await credit(9002, 'USD', 10000, 'deposit', 'payment', 'abc123', key);
    assert.equal(await getBalance(9002, 'USD'), 10000n);
  });

  test('withdraw debit reduces balance', async () => {
    const { debit, getBalance } = require('../wallet');
    await seedUser(9003, 20000);
    await debit(9003, 'USD', 5000, 'withdrawal', 'withdrawal_request', null, 'wd-req-9003-1');
    assert.equal(await getBalance(9003, 'USD'), 15000n);
  });

  test('withdraw reject refunds balance', async () => {
    const { debit, credit, getBalance } = require('../wallet');
    await seedUser(9004, 10000);
    await debit(9004, 'USD', 4000, 'withdrawal', 'withdrawal_request', '1', 'wd-req-9004-1');
    assert.equal(await getBalance(9004, 'USD'), 6000n);
    await credit(9004, 'USD', 4000, 'refund', 'withdrawal_request', '1', 'refund_withdrawal_1');
    assert.equal(await getBalance(9004, 'USD'), 10000n);
  });
});
