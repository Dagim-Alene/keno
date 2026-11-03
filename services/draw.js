'use strict';

/**
 * services/draw.js
 * Exact copy of the provably-fair HMAC-SHA256 draw function from the original server.js.
 * DO NOT modify this function — any change breaks fairness verification for past rounds.
 */

const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic PRNG using HMAC-SHA256.
 * Returns 20 unique numbers from 1–80.
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {number} nonce
 * @returns {number[]}
 */
function generateDrawnNumbers(serverSeed, clientSeed, nonce) {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const seedBuffer = hmac.digest();

  const numbers = Array.from({ length: 80 }, (_, i) => i + 1);
  const drawn = [];
  let bufferIndex = 0;

  for (let i = 0; i < 20; i++) {
    if (bufferIndex >= seedBuffer.length - 2) {
      const nextHmac = crypto.createHmac('sha256', serverSeed);
      nextHmac.update(`${clientSeed}:${nonce}:${bufferIndex}`);
      bufferIndex = 0;
    }
    const randInt = seedBuffer.readUInt16BE(bufferIndex);
    bufferIndex += 2;
    const remaining = numbers.length;
    const pickIndex = randInt % remaining;
    drawn.push(numbers.splice(pickIndex, 1)[0]);
  }
  return drawn;
}

module.exports = { sha256, generateDrawnNumbers };
