#!/usr/bin/env node
'use strict';

/**
 * scripts/verify.js
 * Provably-fair verification CLI:
 *   Mode 1 (Live Shared Round): npm run verify -- <serverSeed> <roundNumber>
 *   Mode 2 (Solo Classic Round): npm run verify -- <serverSeed> <clientSeed> <nonce>
 */

const { generateDrawnNumbers, sha256 } = require('../services/draw');

const args = process.argv.slice(2);

if (args.length === 2) {
  // Shared round verification: serverSeed + roundNumber
  const [serverSeed, roundNumberStr] = args;
  const roundNum = Number(roundNumberStr);
  if (isNaN(roundNum) || roundNum <= 0) {
    console.error('roundNumber must be a positive integer');
    process.exit(1);
  }

  const hash = sha256(serverSeed);
  const drawn = generateDrawnNumbers(serverSeed, String(roundNum), 0);

  console.log('=== Live Shared Round Verification ===');
  console.log(`Server Seed      : ${serverSeed}`);
  console.log(`Published Hash   : ${hash}`);
  console.log(`Round Number     : ${roundNum}`);
  console.log(`Drawn Balls (20) : ${drawn.join(', ')}`);
  process.exit(0);
}

if (args.length >= 3) {
  // Solo round: serverSeed + clientSeed + nonce
  const [serverSeed, clientSeed, nonce] = args;
  const nonceNum = Number(nonce);
  if (!Number.isInteger(nonceNum) || nonceNum < 0) {
    console.error('nonce must be a non-negative integer');
    process.exit(1);
  }

  const drawn = generateDrawnNumbers(serverSeed, clientSeed, nonceNum);

  console.log('=== Solo Round Verification ===');
  console.log(`Server Seed      : ${serverSeed}`);
  console.log(`Client Seed      : ${clientSeed}`);
  console.log(`Nonce            : ${nonceNum}`);
  console.log(`Drawn Balls (20) : ${drawn.join(', ')}`);
  process.exit(0);
}

console.error('Usage:');
console.error('  Live Shared Round : npm run verify -- <serverSeed> <roundNumber>');
console.error('  Solo Classic Round: npm run verify -- <serverSeed> <clientSeed> <nonce>');
process.exit(1);
