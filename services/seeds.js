'use strict';

/**
 * services/seeds.js
 * Manages provably-fair seed pairs in the database.
 */

const crypto = require('crypto');
const { pool } = require('../db/pool');
const { sha256 } = require('./draw');

/**
 * Get (or create) the active seed pair for a user.
 * @param {import('pg').PoolClient|null} client - reuse existing transaction client
 * @param {bigint|number} userId
 * @returns {Promise<{ id: bigint, serverSeed: string, serverSeedHash: string, clientSeed: string, nonce: bigint }>}
 */
async function getActiveSeedPair(userId, client = null) {
  const db = client || pool;

  const { rows } = await db.query(
    `SELECT id, server_seed, server_seed_hash, client_seed, next_nonce
     FROM seed_pairs
     WHERE user_id = $1 AND revealed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(userId)]
  );

  if (rows.length > 0) {
    const r = rows[0];
    return {
      id:             BigInt(r.id),
      serverSeed:     r.server_seed,
      serverSeedHash: r.server_seed_hash,
      clientSeed:     r.client_seed,
      nonce:          BigInt(r.next_nonce),
    };
  }

  // No active pair: create one
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = crypto.randomBytes(12).toString('hex');
  const hash       = sha256(serverSeed);

  const { rows: newRows } = await db.query(
    `INSERT INTO seed_pairs (user_id, server_seed, server_seed_hash, client_seed, next_nonce)
     VALUES ($1, $2, $3, $4, 0)
     RETURNING id, server_seed, server_seed_hash, client_seed, next_nonce`,
    [String(userId), serverSeed, hash, clientSeed]
  );
  const r = newRows[0];
  return {
    id:             BigInt(r.id),
    serverSeed:     r.server_seed,
    serverSeedHash: r.server_seed_hash,
    clientSeed:     r.client_seed,
    nonce:          BigInt(r.next_nonce),
  };
}

/**
 * Increment the nonce on the active seed pair (called inside a Keno round transaction).
 * @param {import('pg').PoolClient} client
 * @param {bigint} seedPairId
 * @returns {Promise<bigint>} the nonce that was consumed (before increment)
 */
async function consumeNonce(client, seedPairId) {
  const { rows } = await client.query(
    `UPDATE seed_pairs
     SET next_nonce = next_nonce + 1
     WHERE id = $1
     RETURNING next_nonce - 1 AS consumed_nonce`,
    [String(seedPairId)]
  );
  return BigInt(rows[0].consumed_nonce);
}

/**
 * Rotate the active seed pair for a user.
 * Marks the old pair as revealed and creates a new one.
 * @param {bigint|number} userId
 * @returns {Promise<{ previousServerSeed: string, newServerSeedHash: string, nonce: bigint }>}
 */
async function rotateSeedPair(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock and get the current active pair
    const { rows: current } = await client.query(
      `SELECT id, server_seed FROM seed_pairs
       WHERE user_id = $1 AND revealed_at IS NULL
       FOR UPDATE`,
      [String(userId)]
    );

    let previousServerSeed = null;
    if (current.length > 0) {
      const oldId = current[0].id;
      previousServerSeed = current[0].server_seed;

      await client.query(
        `UPDATE seed_pairs SET revealed_at = NOW() WHERE id = $1`,
        [oldId]
      );
    }

    // Create new pair
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const clientSeed = crypto.randomBytes(12).toString('hex');
    const hash       = sha256(serverSeed);

    await client.query(
      `INSERT INTO seed_pairs (user_id, server_seed, server_seed_hash, client_seed, next_nonce)
       VALUES ($1, $2, $3, $4, 0)`,
      [String(userId), serverSeed, hash, clientSeed]
    );

    await client.query('COMMIT');

    return {
      previousServerSeed,
      newServerSeedHash: hash,
      nonce: 0n,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update the client seed for the active seed pair.
 * @param {bigint|number} userId
 * @param {string} newClientSeed
 * @returns {Promise<{ clientSeed: string }>}
 */
async function updateClientSeed(userId, newClientSeed) {
  const { rows } = await pool.query(
    `UPDATE seed_pairs
     SET client_seed = $1
     WHERE user_id = $2 AND revealed_at IS NULL
     RETURNING client_seed`,
    [newClientSeed, String(userId)]
  );

  if (rows.length === 0) {
    throw new Error('No active seed pair found');
  }
  return { clientSeed: rows[0].client_seed };
}

module.exports = { getActiveSeedPair, consumeNonce, rotateSeedPair, updateClientSeed };
