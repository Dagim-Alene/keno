'use strict';

/**
 * wallet.js
 * Pure wallet module — zero Keno logic. Reusable for other games.
 *
 * All balance is stored in minor units (integer cents).
 * Every balance mutation runs inside a SELECT ... FOR UPDATE transaction.
 */

const { pool, withTransaction } = require('./db/pool');

const DEFAULT_CURRENCY = 'USD';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a wallet row exists for the user; returns the current balance.
 * Must be called inside an existing transaction with the wallet row already locked,
 * OR can be used standalone to initialise.
 * @param {import('pg').PoolClient} client
 * @param {bigint|number} userId
 * @param {string} currency
 * @returns {Promise<bigint>}
 */
async function _getOrCreateWallet(client, userId, currency = DEFAULT_CURRENCY) {
  const initialBalance = BigInt(process.env.INITIAL_BALANCE_CENTS || 100000);

  const existing = await client.query(
    `SELECT balance FROM wallets WHERE user_id = $1 AND currency = $2 FOR UPDATE`,
    [String(userId), currency]
  );

  if (existing.rows.length > 0) {
    return BigInt(existing.rows[0].balance);
  }

  await client.query(
    `INSERT INTO wallets (user_id, currency, balance)
     VALUES ($1, $2, $3)`,
    [String(userId), currency, String(initialBalance)]
  );

  if (initialBalance > 0n) {
    await client.query(
      `INSERT INTO ledger_entries
         (user_id, currency, type, amount, balance_after, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, 'deposit', $3, $3, 'initial_bonus', NULL, $4)`,
      [String(userId), currency, String(initialBalance), `initial_bonus_${userId}_${currency}`]
    );
  }

  return initialBalance;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current balance (in cents) for a user.
 * @param {bigint|number} userId
 * @param {string} [currency]
 * @returns {Promise<bigint>}
 */
async function getBalance(userId, currency = DEFAULT_CURRENCY) {
  const { rows } = await pool.query(
    `SELECT balance FROM wallets WHERE user_id = $1 AND currency = $2`,
    [String(userId), currency]
  );
  if (rows.length === 0) return BigInt(0);
  return BigInt(rows[0].balance);
}

/**
 * Credit (add funds) to a wallet.
 * Idempotent: calling with the same idempotencyKey always returns the same ledger entry.
 *
 * @param {bigint|number} userId
 * @param {string}        currency
 * @param {bigint|number} amountCents  Must be > 0
 * @param {string}        type         'deposit'|'win'|'refund'|'adjustment'
 * @param {string}        [refType]    e.g. 'keno_round'
 * @param {string}        [refId]      e.g. round id
 * @param {string}        [idempotencyKey]
 * @param {import('pg').PoolClient} [txClient]  Supply to reuse an existing transaction
 * @returns {Promise<{ ledgerId: bigint, balanceAfter: bigint }>}
 */
async function credit(
  userId, currency, amountCents, type, refType = null, refId = null,
  idempotencyKey = null, txClient = null
) {
  if (BigInt(amountCents) <= 0n) throw new Error('Credit amount must be positive');

  const run = async (client) => {
    // Idempotency check
    if (idempotencyKey) {
      const { rows } = await client.query(
        `SELECT id, balance_after FROM ledger_entries WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (rows.length > 0) {
        return { ledgerId: BigInt(rows[0].id), balanceAfter: BigInt(rows[0].balance_after) };
      }
    }

    const balance = await _getOrCreateWallet(client, userId, currency);
    const newBalance = balance + BigInt(amountCents);

    await client.query(
      `UPDATE wallets SET balance = $1, updated_at = NOW()
       WHERE user_id = $2 AND currency = $3`,
      [String(newBalance), String(userId), currency]
    );

    const { rows } = await client.query(
      `INSERT INTO ledger_entries
         (user_id, currency, type, amount, balance_after, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [String(userId), currency, type, String(BigInt(amountCents)),
       String(newBalance), refType, refId, idempotencyKey]
    );

    return { ledgerId: BigInt(rows[0].id), balanceAfter: newBalance };
  };

  return txClient ? run(txClient) : withTransaction(run);
}

/**
 * Debit (subtract funds) from a wallet.
 * Idempotent: calling with the same idempotencyKey always returns the same result.
 * Throws if balance would go negative.
 *
 * @param {bigint|number} userId
 * @param {string}        currency
 * @param {bigint|number} amountCents  Must be > 0
 * @param {string}        type         'bet'|'withdrawal'|'adjustment'
 * @param {string}        [refType]
 * @param {string}        [refId]
 * @param {string}        [idempotencyKey]
 * @param {import('pg').PoolClient} [txClient]
 * @returns {Promise<{ ledgerId: bigint, balanceAfter: bigint }>}
 */
async function debit(
  userId, currency, amountCents, type, refType = null, refId = null,
  idempotencyKey = null, txClient = null
) {
  if (BigInt(amountCents) <= 0n) throw new Error('Debit amount must be positive');

  const run = async (client) => {
    // Idempotency check
    if (idempotencyKey) {
      const { rows } = await client.query(
        `SELECT id, balance_after FROM ledger_entries WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (rows.length > 0) {
        return { ledgerId: BigInt(rows[0].id), balanceAfter: BigInt(rows[0].balance_after) };
      }
    }

    const balance = await _getOrCreateWallet(client, userId, currency);
    const debitAmount = BigInt(amountCents);

    if (balance < debitAmount) {
      const err = new Error('Insufficient balance');
      err.code = 'INSUFFICIENT_BALANCE';
      throw err;
    }

    const newBalance = balance - debitAmount;

    await client.query(
      `UPDATE wallets SET balance = $1, updated_at = NOW()
       WHERE user_id = $2 AND currency = $3`,
      [String(newBalance), String(userId), currency]
    );

    const { rows } = await client.query(
      `INSERT INTO ledger_entries
         (user_id, currency, type, amount, balance_after, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [String(userId), currency, type, String(-debitAmount),
       String(newBalance), refType, refId, idempotencyKey]
    );

    return { ledgerId: BigInt(rows[0].id), balanceAfter: newBalance };
  };

  return txClient ? run(txClient) : withTransaction(run);
}

/**
 * Ensure a user row exists (upsert).
 * @param {import('pg').PoolClient} client
 * @param {bigint|number} userId
 * @param {string}        [username]
 * @param {string}        [country]
 */
async function ensureUser(client, userId, username = null, country = null) {
  await client.query(
    `INSERT INTO users (id, username, country)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, users.username),
       country  = COALESCE(EXCLUDED.country,  users.country)`,
    [String(userId), username, country]
  );
}

module.exports = { getBalance, credit, debit, ensureUser, _getOrCreateWallet };
