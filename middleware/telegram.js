'use strict';

/**
 * middleware/telegram.js
 * Validates Telegram WebApp initData and sets req.userId.
 *
 * In development (NODE_ENV !== 'production'), falls back to
 * the X-Dev-User-Id header so you can test without a real Telegram session.
 *
 * Rejects initData older than 1 hour on state-changing requests.
 */

const crypto = require('crypto');

const BOT_TOKEN   = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const IS_DEV      = process.env.NODE_ENV !== 'production';
const MAX_AGE_MS  = 60 * 60 * 1000; // 1 hour

/**
 * Parse and validate Telegram initData.
 * Returns { userId, username } or throws.
 */
function parseInitData(initData) {
  if (!initData) throw new Error('No initData');

  const params  = new URLSearchParams(initData);
  const hash    = params.get('hash');
  if (!hash) throw new Error('Missing hash in initData');

  // Build the data-check string
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected  = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) {
    throw new Error('initData signature invalid');
  }

  const authDate = Number(params.get('auth_date'));
  if (isNaN(authDate) || Date.now() - authDate * 1000 > MAX_AGE_MS) {
    throw new Error('initData is too old (> 1 hour)');
  }

  let userObj = {};
  try { userObj = JSON.parse(params.get('user') || '{}'); } catch {}

  return {
    userId:   userObj.id,
    username: userObj.username || null,
  };
}

/**
 * Express middleware.
 * Applies to all /api/* and /webhooks/* routes EXCEPT the payment webhook
 * (which has its own HMAC verification).
 */
function telegramAuth(req, res, next) {
  // Skip auth for static files
  if (!req.path.startsWith('/api') && !req.path.startsWith('/webhooks')) {
    return next();
  }
  // Payment webhook uses its own HMAC — skip
  if (req.path === '/webhooks/payments') {
    return next();
  }

  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;

  if (IS_DEV && !initData) {
    // Development fallback: accept a plain user-id header, or default to local dev user
    const devUserId = req.headers['x-dev-user-id'] || '100001';
    req.userId          = BigInt(devUserId);
    req.telegramUsername = req.headers['x-dev-username'] || 'dev_player';
    return next();
  }

  if (!initData) {
    return res.status(401).json({ error: 'Unauthorized: initData required.' });
  }

  // Validate in production; in dev, just parse (without strict signature check if no token)
  if (!IS_DEV || BOT_TOKEN) {
    try {
      const { userId, username } = parseInitData(initData);
      req.userId          = BigInt(userId);
      req.telegramUsername = username;
      return next();
    } catch (err) {
      console.error('[telegramAuth] Signature validation failed:', err.message);
      return res.status(401).json({ error: `Unauthorized: ${err.message}` });
    }
  }

  // Dev mode, no token: best-effort parse
  try {
    const params = new URLSearchParams(initData);
    let userObj = {};
    try { userObj = JSON.parse(params.get('user') || '{}'); } catch {}
    req.userId          = BigInt(userObj.id || 0);
    req.telegramUsername = userObj.username || null;
  } catch {
    req.userId = 0n;
  }
  next();
}

module.exports = telegramAuth;
