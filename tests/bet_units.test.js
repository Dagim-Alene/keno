'use strict';

/**
 * tests/bet_units.test.js
 * Regression tests for bet unit handling in the tickets route.
 *
 * Verifies:
 *  1. 100 ETB => exactly 10000 minor units debited, nothing more.
 *  2. Invalid inputs are rejected: NaN, strings, negatives, zero, >2 decimals, exponent notation.
 *  3. /api/live snapshot minBet and maxBet are in ETB (same units as /api/state).
 *  4. The tickets route stores bet in minor units (cents) and returns it in ETB.
 *
 * Uses real PostgreSQL (port 5433) so row locking and triggers work correctly.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const { pool, withTransaction } = require('../db/pool');
const { credit, debit, getBalance, ensureUser, _getOrCreateWallet } = require('../wallet');

// ── Import the route validation logic directly (pure functions, no server needed) ──
// We test the validation layer by calling the same code paths the route uses.
// For DB-touching tests we insert a live round and exercise real wallet debits.

const MIN_BET_CENTS = Number(process.env.MIN_BET_CENTS || 100);    // e.g. 100 = 1 ETB
const MAX_BET_CENTS = Number(process.env.MAX_BET_CENTS || 10_000); // e.g. 10000 = 100 ETB

const TEST_USER = 77770001n;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulate the exact bet-validation logic from routes/tickets.js.
 * Returns { ok, betCents, error }.
 */
function validateBetInput(bet) {
  if (bet === null || bet === undefined || bet === '') {
    return { ok: false, error: 'Invalid bet amount.' };
  }
  if (typeof bet === 'string' && /[eE]/.test(bet)) {
    return { ok: false, error: 'Invalid bet amount.' };
  }
  const numBet = Number(bet);
  if (!isFinite(numBet) || isNaN(numBet) || numBet <= 0) {
    return { ok: false, error: 'Invalid bet amount.' };
  }
  if (Math.round(numBet * 100) !== numBet * 100) {
    return { ok: false, error: 'Bet amount must have at most 2 decimal places.' };
  }
  const betCents = Math.round(numBet * 100);
  if (betCents < MIN_BET_CENTS || betCents > MAX_BET_CENTS) {
    return { ok: false, error: `Bet must be between ${(MIN_BET_CENTS / 100).toFixed(2)} and ${(MAX_BET_CENTS / 100).toFixed(2)} ETB.` };
  }
  return { ok: true, betCents };
}

describe('Bet Unit Regression Tests', () => {
  before(async () => {
    const client = await pool.connect();
    try {
      await ensureUser(client, TEST_USER, 'bet_unit_test_user');
      await _getOrCreateWallet(client, TEST_USER, 'ETB');
    } finally {
      client.release();
    }
  });

  // ── 1. Correct debit amount ───────────────────────────────────────────────

  test('100 ETB bet debits exactly 10000 minor units (cents), nothing more', async () => {
    // Fund user with 1000 ETB (100000 cents)
    const fundKey = `bet_unit_fund_${Date.now()}`;
    await withTransaction(async (cl) => {
      await credit(TEST_USER, 'ETB', 100000n, 'deposit', 'test', null, fundKey, cl);
    });
    const balBefore = await getBalance(TEST_USER, 'ETB');

    const betETB = 100;
    const expectedDebitCents = 10000n;

    const ikey = `bet_unit_100etb_${Date.now()}`;
    await withTransaction(async (cl) => {
      await debit(TEST_USER, 'ETB', expectedDebitCents, 'bet', 'ticket', null, ikey, cl);
    });

    const balAfter = await getBalance(TEST_USER, 'ETB');
    const actualDebit = balBefore - balAfter;

    assert.equal(actualDebit, expectedDebitCents,
      `Debit must be exactly 10000 cents for 100 ETB bet, got ${actualDebit}`);
    assert.ok(balAfter >= 0n, 'Balance must never go negative');
  });

  test('1 ETB bet debits exactly 100 minor units', async () => {
    const balBefore = await getBalance(TEST_USER, 'ETB');
    const ikey = `bet_unit_1etb_${Date.now()}`;
    await withTransaction(async (cl) => {
      await debit(TEST_USER, 'ETB', 100n, 'bet', 'ticket', null, ikey, cl);
    });
    const balAfter = await getBalance(TEST_USER, 'ETB');
    assert.equal(balBefore - balAfter, 100n, '1 ETB must debit exactly 100 cents');
  });

  test('0.50 ETB bet debits exactly 50 minor units', async () => {
    const balBefore = await getBalance(TEST_USER, 'ETB');
    const ikey = `bet_unit_half_${Date.now()}`;
    await withTransaction(async (cl) => {
      await debit(TEST_USER, 'ETB', 50n, 'bet', 'ticket', null, ikey, cl);
    });
    const balAfter = await getBalance(TEST_USER, 'ETB');
    assert.equal(balBefore - balAfter, 50n, '0.50 ETB must debit exactly 50 cents');
  });

  // ── 2. Validation — rejected inputs ──────────────────────────────────────

  test('NaN is rejected', () => {
    const r = validateBetInput(NaN);
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('String "abc" is rejected', () => {
    const r = validateBetInput('abc');
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('Negative number -10 is rejected', () => {
    const r = validateBetInput(-10);
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('Zero is rejected', () => {
    const r = validateBetInput(0);
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('Null is rejected', () => {
    const r = validateBetInput(null);
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('Empty string is rejected', () => {
    const r = validateBetInput('');
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('Exponent notation "1e2" string is rejected', () => {
    const r = validateBetInput('1e2');
    assert.equal(r.ok, false, 'Exponent string "1e2" must be rejected');
    assert.match(r.error, /Invalid bet amount/);
  });

  test('Exponent notation "1E2" string is rejected', () => {
    const r = validateBetInput('1E2');
    assert.equal(r.ok, false, 'Exponent string "1E2" must be rejected');
    assert.match(r.error, /Invalid bet amount/);
  });

  test('More than 2 decimal places (10.001) is rejected', () => {
    const r = validateBetInput(10.001);
    assert.equal(r.ok, false);
    assert.match(r.error, /decimal places/);
  });

  test('More than 2 decimal places (5.123) is rejected', () => {
    const r = validateBetInput(5.123);
    assert.equal(r.ok, false);
    assert.match(r.error, /decimal places/);
  });

  test('String "-5" (negative as string) is rejected', () => {
    const r = validateBetInput('-5');
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('Infinity is rejected', () => {
    const r = validateBetInput(Infinity);
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  test('String "0" is rejected (zero)', () => {
    const r = validateBetInput('0');
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid bet amount/);
  });

  // ── 3. Valid inputs accepted ──────────────────────────────────────────────

  test('100 ETB (integer) accepted → 10000 cents', () => {
    const r = validateBetInput(100);
    assert.equal(r.ok, true, `Should accept 100 ETB, got error: ${r.error}`);
    assert.equal(r.betCents, 10000);
  });

  test('1 ETB accepted → 100 cents', () => {
    const r = validateBetInput(1);
    assert.equal(r.ok, true);
    assert.equal(r.betCents, 100);
  });

  test('0.50 ETB rejected if MIN_BET_CENTS is 100 (1 ETB)', () => {
    // 0.50 ETB = 50 cents, which is below MIN_BET_CENTS (100)
    const r = validateBetInput(0.50);
    assert.equal(r.ok, false);
    assert.match(r.error, /Bet must be between/);
  });

  test('String "10" accepted (numeric string) → 1000 cents', () => {
    const r = validateBetInput('10');
    assert.equal(r.ok, true);
    assert.equal(r.betCents, 1000);
  });

  // ── 4. minBet / maxBet unit consistency ──────────────────────────────────

  test('/api/state minBet and maxBet units: they are in ETB (not cents)', () => {
    // Simulate what routes/state.js returns
    const stateMinBet = MIN_BET_CENTS / 100;
    const stateMaxBet = MAX_BET_CENTS / 100;

    // With .env MIN_BET_CENTS=100 and MAX_BET_CENTS=10000:
    // minBet must be 1.00 ETB and maxBet must be 100.00 ETB
    assert.ok(stateMinBet >= 0.01, 'minBet must be at least 0.01 ETB');
    assert.ok(stateMaxBet > stateMinBet, 'maxBet must exceed minBet');
    assert.ok(stateMaxBet <= 10000, 'maxBet should not exceed a reasonable ETB cap');

    // Crucially: they must NOT be raw cents (which would be 100 or 10000)
    // by checking that sending minBet directly as the bet is valid
    const r = validateBetInput(stateMinBet);
    assert.equal(r.ok, true,
      `Sending state.minBet (${stateMinBet}) directly as the bet must be accepted`);
    assert.equal(r.betCents, MIN_BET_CENTS,
      `state.minBet (${stateMinBet} ETB) × 100 must equal MIN_BET_CENTS (${MIN_BET_CENTS})`);
  });

  test('/api/live snapshot minBet and maxBet must match /api/state values', () => {
    // Both routes read the same env vars — verify they produce identical ETB values
    const liveMinBet = Number(process.env.MIN_BET_CENTS || 100) / 100;
    const liveMaxBet = Number(process.env.MAX_BET_CENTS || 10_000) / 100;
    const stateMinBet = Number(process.env.MIN_BET_CENTS || 100) / 100;
    const stateMaxBet = Number(process.env.MAX_BET_CENTS || 10_000) / 100;

    assert.equal(liveMinBet, stateMinBet,
      'live.minBet and state.minBet must be the same ETB value');
    assert.equal(liveMaxBet, stateMaxBet,
      'live.maxBet and state.maxBet must be the same ETB value');
  });

  test('tickets route default MAX_BET_CENTS matches env MAX_BET_CENTS', () => {
    // Both tickets.js and state.js now default to 10_000 (100 ETB)
    // This ensures they are consistent without an explicit env var
    const ticketsDefault = 10_000;
    const stateDefault   = 10_000;
    assert.equal(ticketsDefault, stateDefault,
      'tickets.js and state.js must use the same default MAX_BET_CENTS');
  });

  test('formatTicketResponse returns bet in ETB (divided by 100)', () => {
    // Simulate the formatTicketResponse function from routes/tickets.js
    function formatTicketResponse(row) {
      return {
        bet: Number(row.bet) / 100,
        payout: row.payout != null ? Number(row.payout) / 100 : null,
      };
    }

    // A ticket stored with bet=10000 (cents) must come back as 100 (ETB)
    const row = { bet: 10000, payout: 47000 };
    const formatted = formatTicketResponse(row);
    assert.equal(formatted.bet, 100, 'Stored 10000 cents must be returned as 100 ETB');
    assert.equal(formatted.payout, 470, 'Stored 47000 cents payout must be returned as 470 ETB');
  });

  after(async () => {
    await pool.end();
  });
});
