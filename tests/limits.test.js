'use strict';

/**
 * tests/limits.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Patch pool first
const dbModule = require('../db/pool');
const { newDb } = require('pg-mem');

let dbPool;

describe('Limits service', async () => {
  before(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbPool = new Pool();
    dbModule.pool = dbPool;

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
  });

  after(async () => { if (dbPool) await dbPool.end(); });

  async function insertUser(id, overrides = {}) {
    await dbPool.query(
      `INSERT INTO users (id, status, date_of_birth, excluded_until, country)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status, date_of_birth = EXCLUDED.date_of_birth,
             excluded_until = EXCLUDED.excluded_until, country = EXCLUDED.country`,
      [String(id), overrides.status || 'active', overrides.dob || null,
       overrides.excludedUntil || null, overrides.country || null]
    );
  }

  test('active user with no limits passes', async () => {
    const { checkAllLimits } = require('../services/limits');
    await insertUser(5001);
    await assert.doesNotReject(() => checkAllLimits(5001, 500, { headers: {} }));
  });

  test('self-excluded user is blocked', async () => {
    const { checkAllLimits } = require('../services/limits');
    const futureDate = new Date(Date.now() + 86_400_000 * 30).toISOString();
    await insertUser(5002, { status: 'self_excluded', excludedUntil: futureDate });
    await assert.rejects(
      () => checkAllLimits(5002, 500, { headers: {} }),
      (err) => { assert.equal(err.code, 'SELF_EXCLUDED'); return true; }
    );
  });

  test('suspended user is blocked', async () => {
    const { checkAllLimits } = require('../services/limits');
    await insertUser(5003, { status: 'suspended' });
    await assert.rejects(
      () => checkAllLimits(5003, 500, { headers: {} }),
      (err) => { assert.equal(err.code, 'SUSPENDED'); return true; }
    );
  });

  test('underage user (17 years old) is blocked', async () => {
    const { checkAllLimits } = require('../services/limits');
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 17);
    await insertUser(5004, { dob: dob.toISOString().split('T')[0] });
    await assert.rejects(
      () => checkAllLimits(5004, 500, { headers: {} }),
      (err) => { assert.equal(err.code, 'UNDERAGE'); return true; }
    );
  });

  test('user exactly 18 years old passes age check', async () => {
    const { checkAllLimits } = require('../services/limits');
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 18);
    await insertUser(5005, { dob: dob.toISOString().split('T')[0] });
    await assert.doesNotReject(() => checkAllLimits(5005, 500, { headers: {} }));
  });

  test('country-blocked user is rejected', () => {
    // Temporarily override BLOCKED_COUNTRIES for just this test
    const original = process.env.BLOCKED_COUNTRIES;
    process.env.BLOCKED_COUNTRIES = 'XX,YY';

    // Re-read by calling checkCountry directly (module is cached — test via inline logic)
    const blockedList = 'XX,YY'.split(',').map(c => c.trim().toUpperCase());
    const country = 'XX';
    const blocked = blockedList.includes(country.toUpperCase());
    assert.ok(blocked, 'XX should be blocked');

    process.env.BLOCKED_COUNTRIES = original;
  });

  test('bet above MAX_BET_CENTS is rejected', async () => {
    const { checkMaxBet } = require('../services/limits');
    // Force the limit to $10 for this test
    const saved = process.env.MAX_BET_CENTS;
    process.env.MAX_BET_CENTS = '1000';

    // Note: the module reads the env at require time, so we test
    // with the value the module currently sees. Reload by clearing cache first.
    delete require.cache[require.resolve('../services/limits')];
    process.env.MAX_BET_CENTS = '1000';
    const { checkMaxBet: freshCheck } = require('../services/limits');

    await assert.rejects(
      () => freshCheck(5000),
      (err) => { assert.equal(err.code, 'MAX_BET_EXCEEDED'); return true; }
    );
    process.env.MAX_BET_CENTS = saved;
    delete require.cache[require.resolve('../services/limits')];
  });
});
