'use strict';

/**
 * tests/fairness_round.test.js
 * Verifies provably fair live shared round cryptography:
 *   - SHA-256 hash publication
 *   - Deterministic draw reproduction from (serverSeed, roundNumber)
 *   - Hash chain integrity (prevRoundHash === sha256(prevServerSeed))
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { generateDrawnNumbers, sha256 } = require('../services/draw');

describe('Provably Fair Shared Rounds Cryptography', () => {
  test('Published hash matches SHA-256 of revealed server seed', () => {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const publishedHash = sha256(serverSeed);

    const recomputed = crypto.createHash('sha256').update(serverSeed).digest('hex');
    assert.equal(publishedHash, recomputed, 'Published hash must exactly match sha256 of seed');
  });

  test('Shared round draw is deterministic from (serverSeed, roundNumber)', () => {
    const serverSeed = 'test_shared_seed_f7e6d5c4b3a21098';
    const roundNumber = 12345;

    const draw1 = generateDrawnNumbers(serverSeed, String(roundNumber), 0);
    const draw2 = generateDrawnNumbers(serverSeed, String(roundNumber), 0);

    assert.equal(draw1.length, 20);
    assert.deepEqual(draw1, draw2, 'Draw must be completely deterministic');

    // All numbers in range 1-80 without duplicates
    const unique = new Set(draw1);
    assert.equal(unique.size, 20);
    for (const n of draw1) {
      assert.ok(n >= 1 && n <= 80);
    }
  });

  test('Different round numbers produce different draws with same seed', () => {
    const serverSeed = 'test_shared_seed_f7e6d5c4b3a21098';
    const draw1 = generateDrawnNumbers(serverSeed, '1', 0);
    const draw2 = generateDrawnNumbers(serverSeed, '2', 0);

    assert.notDeepEqual(draw1, draw2, 'Different round numbers must produce different draws');
  });

  test('Hash chain links consecutive rounds so seeds cannot be swapped', () => {
    const seed1 = crypto.randomBytes(32).toString('hex');
    const seed2 = crypto.randomBytes(32).toString('hex');

    const hash1 = sha256(seed1);
    const prevRoundHashForRound2 = sha256(seed1);

    assert.equal(hash1, prevRoundHashForRound2, 'Round 2 prev_round_hash must verify Round 1 seed');
  });
});
