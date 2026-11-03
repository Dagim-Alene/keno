#!/usr/bin/env node
'use strict';

/**
 * scripts/verify.js
 * Reproduces a Keno draw from seeds — used for provably-fair verification.
 *
 * Usage:
 *   npm run verify -- <serverSeed> <clientSeed> <nonce>
 *
 * Example:
 *   npm run verify -- abc123 def456 7
 */

const { generateDrawnNumbers } = require('../services/draw');

const [serverSeed, clientSeed, nonce] = process.argv.slice(2);

if (!serverSeed || !clientSeed || nonce === undefined) {
  console.error('Usage: npm run verify -- <serverSeed> <clientSeed> <nonce>');
  process.exit(1);
}

const nonceNum = Number(nonce);
if (!Number.isInteger(nonceNum) || nonceNum < 0) {
  console.error('nonce must be a non-negative integer');
  process.exit(1);
}

const drawn = generateDrawnNumbers(serverSeed, clientSeed, nonceNum);

console.log('=== Keno Draw Verification ===');
console.log(`Server Seed : ${serverSeed}`);
console.log(`Client Seed : ${clientSeed}`);
console.log(`Nonce       : ${nonceNum}`);
console.log(`Drawn (20)  : ${drawn.join(', ')}`);
