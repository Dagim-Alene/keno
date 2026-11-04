'use strict';

/**
 * services/limits.js
 * Server-side responsible-gaming and safety checks.
 * All checks throw with a machine-readable { code, message } on failure.
 */

const { pool } = require('../db/pool');

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const MAX_BET_CENTS              = BigInt(process.env.MAX_BET_CENTS || 10_000);
// DEFAULT_DAILY_LOSS_LIMIT_CENTS: 0 or unset means NO limit by default.
function getDefaultDailyLossLimit() {
  const val = process.env.DEFAULT_DAILY_LOSS_LIMIT_CENTS;
  if (!val) return 0n;
  const num = Number(val);
  return (isFinite(num) && num > 0) ? BigInt(num) : 0n;
}
const MIN_AGE_YEARS              = Number(process.env.MIN_AGE_YEARS || 18);
const BLOCKED_COUNTRIES          = (process.env.BLOCKED_COUNTRIES || '')
  .split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function limitError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = 403;
  return err;
}

/**
 * Read the player's country from request headers.
 * Pluggable: replace this function to use a different geo source.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getCountryFromRequest(req) {
  // Cloudflare sets CF-IPCountry; fall back to a custom header for testing
  return (
    req.headers['cf-ipcountry'] ||
    req.headers['x-country-code'] ||
    null
  );
}

// ---------------------------------------------------------------------------
// Individual checks (each throws on failure)
// ---------------------------------------------------------------------------

async function checkSelfExclusion(userId) {
  const { rows } = await pool.query(
    `SELECT status, excluded_until FROM users WHERE id = $1`,
    [String(userId)]
  );
  if (rows.length === 0) return; // new user, will be created

  const { status, excluded_until } = rows[0];
  if (status === 'suspended') {
    throw limitError('SUSPENDED', 'Your account has been suspended. Please contact support.');
  }
  if (status === 'self_excluded') {
    const until = excluded_until ? new Date(excluded_until) : null;
    if (!until || until > new Date()) {
      const msg = until
        ? `You have self-excluded until ${until.toDateString()}.`
        : 'You have permanently self-excluded.';
      throw limitError('SELF_EXCLUDED', msg);
    }
    // Exclusion period expired — restore to active
    await pool.query(
      `UPDATE users SET status = 'active', excluded_until = NULL WHERE id = $1`,
      [String(userId)]
    );
  }
}

async function checkAge(userId) {
  const { rows } = await pool.query(
    `SELECT date_of_birth FROM users WHERE id = $1`,
    [String(userId)]
  );
  if (rows.length === 0 || !rows[0].date_of_birth) return; // no DOB recorded

  const dob  = new Date(rows[0].date_of_birth);
  const now  = new Date();
  let age    = now.getFullYear() - dob.getFullYear();
  const m    = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;

  if (age < MIN_AGE_YEARS) {
    throw limitError('UNDERAGE', `You must be at least ${MIN_AGE_YEARS} years old to play.`);
  }
}

function checkCountry(req) {
  if (BLOCKED_COUNTRIES.length === 0) return;
  const country = getCountryFromRequest(req);
  if (country && BLOCKED_COUNTRIES.includes(country.toUpperCase())) {
    throw limitError('GEO_BLOCKED', 'This service is not available in your region.');
  }
}

async function checkMaxBet(betCents) {
  if (BigInt(betCents) > MAX_BET_CENTS) {
    throw limitError(
      'MAX_BET_EXCEEDED',
      `Maximum single bet is $${(Number(MAX_BET_CENTS) / 100).toFixed(2)}.`
    );
  }
}

async function checkDailyLossLimit(userId) {
  // 1. Fetch user's custom daily loss limit if any
  let userLimit = null;
  try {
    const { rows: uRows } = await pool.query(
      `SELECT daily_loss_limit_cents FROM users WHERE id = $1`,
      [String(userId)]
    );
    if (uRows.length > 0 && uRows[0].daily_loss_limit_cents != null) {
      userLimit = BigInt(uRows[0].daily_loss_limit_cents);
    }
  } catch (_) {
    // If column doesn't exist yet in mock db/tests, fallback to env
  }

  // Determine effective limit:
  // User's custom limit takes precedence if set.
  // Otherwise, default from env applies (0 or unset means NO limit).
  const defaultLimit = getDefaultDailyLossLimit();
  const effectiveLimit = userLimit !== null ? userLimit : defaultLimit;

  // If effective limit is 0 or negative, daily loss limit is disabled
  if (effectiveLimit <= 0n) {
    return;
  }

  // Calculate start of day (midnight UTC / local)
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Sum of bets placed today (bet entries are negative in the ledger)
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(-amount), 0)::bigint AS daily_loss
     FROM ledger_entries
     WHERE user_id = $1
       AND type = 'bet'
       AND created_at >= $2`,
    [String(userId), startOfDay.toISOString()]
  );
  const dailyLoss = BigInt(rows[0].daily_loss);
  if (dailyLoss >= effectiveLimit) {
    throw limitError(
      'DAILY_LOSS_LIMIT',
      `You have reached your daily loss limit of ${(Number(effectiveLimit) / 100).toFixed(2)} ETB.`
    );
  }
}

// ---------------------------------------------------------------------------
// Combined check — call this before every play
// ---------------------------------------------------------------------------

/**
 * Runs all limit checks. Throws on any violation.
 * @param {bigint|number} userId
 * @param {bigint|number} betCents
 * @param {import('express').Request} req
 */
async function checkAllLimits(userId, betCents, req) {
  checkCountry(req);
  await checkSelfExclusion(userId);
  await checkAge(userId);
  await checkMaxBet(betCents);
  await checkDailyLossLimit(userId);
}

module.exports = {
  checkAllLimits,
  checkSelfExclusion,
  checkAge,
  checkCountry,
  checkMaxBet,
  checkDailyLossLimit,
  getCountryFromRequest,
};
