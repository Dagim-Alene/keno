'use strict';

/**
 * rtp.js
 * Theoretical Return To Player (RTP) calculations for Keno.
 * Uses exact hypergeometric distribution:
 * P(X = k) = C(K, k) * C(N - K, n - k) / C(N, n)
 * where N = 80 total numbers, n = 20 drawn numbers, K = player picks, k = hits.
 */

const { PAYTABLE } = require('./paytable');

function logFact(n) {
  let r = 0;
  for (let i = 2; i <= n; i++) r += Math.log(i);
  return r;
}

function logCombination(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return logFact(n) - logFact(k) - logFact(n - k);
}

function hypergeometricProbability(N, K, n, k) {
  return Math.exp(logCombination(K, k) + logCombination(N - K, n - k) - logCombination(N, n));
}

function calculateTheoreticalRtp(pickCount) {
  const table = PAYTABLE[pickCount] || {};
  let expectedReturn = 0;
  for (let hits = 0; hits <= Math.min(pickCount, 20); hits++) {
    const prob = hypergeometricProbability(80, pickCount, 20, hits);
    const multiplier = table[hits] || 0;
    expectedReturn += prob * multiplier;
  }
  return expectedReturn * 100;
}

const THEORETICAL_RTP = {};
for (let p = 1; p <= 10; p++) {
  THEORETICAL_RTP[p] = Number(calculateTheoreticalRtp(p).toFixed(4));
}

module.exports = {
  THEORETICAL_RTP,
  calculateTheoreticalRtp,
  hypergeometricProbability,
};
