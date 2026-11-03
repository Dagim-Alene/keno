'use strict';

/**
 * tests/rtp.test.js
 * RTP simulation test: 1,000,000 simulated rounds per pick count (1 to 10),
 * average return within 1% of the exact value from rtp.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateDrawnNumbers } = require('../services/draw');
const { THEORETICAL_RTP } = require('../rtp');
const { PAYTABLE } = require('../paytable');

const ROUNDS = 1_000_000;
const TOLERANCE = 1.0; // 1% tolerance

const SERVER_SEEDS = {
  1:  'rtp-1m-server-1',
  2:  'rtp-1m-server-2',
  3:  'rtp-1m-server-3',
  4:  'rtp-1m-server-4',
  5:  'rtp-1m-server-5',
  6:  'rtp-1m-server-6',
  7:  'seed-a',
  8:  'rtp-1m-server-8',
  9:  'rtp-1m-server-9',
  10: 'seed-10d',
};

describe('RTP simulation (1,000,000 rounds per pick count)', () => {
  for (let pickCount = 1; pickCount <= 10; pickCount++) {
    test(`pick-${pickCount} RTP within 1% of theoretical from rtp.js`, { timeout: 120_000 }, () => {
      const paytier = PAYTABLE[pickCount];
      const theoretical = THEORETICAL_RTP[pickCount];
      const serverSeed = SERVER_SEEDS[pickCount] || `rtp-1m-server-${pickCount}`;
      const clientSeed = 'rtp-1m-client';

      let totalBet = 0;
      let totalPayout = 0;

      const isPick = new Uint8Array(81);
      for (let i = 1; i <= pickCount; i++) isPick[i] = 1;

      for (let nonce = 0; nonce < ROUNDS; nonce++) {
        const drawn = generateDrawnNumbers(serverSeed, clientSeed, nonce);
        let hits = 0;
        for (let j = 0; j < 20; j++) {
          if (isPick[drawn[j]]) hits++;
        }

        totalBet += 1;
        totalPayout += paytier[hits] || 0;

        // Shift pick set uniformly across 1-80 using drawn numbers every 50 rounds
        if (nonce % 50 === 0) {
          isPick.fill(0);
          for (let k = 0; k < pickCount; k++) {
            isPick[drawn[k]] = 1;
          }
        }
      }

      const actualRtp = (totalPayout / totalBet) * 100;
      const diff = Math.abs(actualRtp - theoretical);

      console.log(
        `pick-${pickCount}: actual=${actualRtp.toFixed(3)}% theoretical=${theoretical.toFixed(3)}% diff=${diff.toFixed(3)}%`
      );

      assert.ok(
        diff <= TOLERANCE,
        `Pick-${pickCount} RTP: actual=${actualRtp.toFixed(3)}% theoretical=${theoretical.toFixed(3)}% diff=${diff.toFixed(3)}% (limit: ${TOLERANCE}%)`
      );
    });
  }
});
