'use strict';

/**
 * tests/draw.test.js
 * Verifies the draw function is deterministic and produces valid results.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateDrawnNumbers, sha256 } = require('../services/draw');

describe('Draw function', () => {
  test('returns exactly 20 numbers', () => {
    const drawn = generateDrawnNumbers('serverSeed', 'clientSeed', 0);
    assert.equal(drawn.length, 20);
  });

  test('all numbers are in range [1, 80]', () => {
    const drawn = generateDrawnNumbers('serverSeed', 'clientSeed', 0);
    for (const n of drawn) {
      assert.ok(n >= 1 && n <= 80, `Number ${n} out of range`);
    }
  });

  test('no duplicates', () => {
    const drawn = generateDrawnNumbers('serverSeed', 'clientSeed', 0);
    assert.equal(new Set(drawn).size, 20, 'All drawn numbers must be unique');
  });

  test('is deterministic: same inputs → same output', () => {
    const a = generateDrawnNumbers('abc', 'def', 5);
    const b = generateDrawnNumbers('abc', 'def', 5);
    assert.deepEqual(a, b);
  });

  test('different nonces produce different draws', () => {
    const a = generateDrawnNumbers('abc', 'def', 0);
    const b = generateDrawnNumbers('abc', 'def', 1);
    assert.notDeepEqual(a, b);
  });

  test('sha256 of known input', () => {
    const hash = sha256('hello');
    assert.equal(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
