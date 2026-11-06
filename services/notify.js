'use strict';

/**
 * services/notify.js
 * Telegram Bot API notifications for players and admins.
 * Silently swallows errors (notification failures are non-fatal).
 */

const https = require('https');

const BOT_TOKEN    = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim();

/**
 * Send a Telegram message via Bot API.
 * @param {string|number} chatId
 * @param {string} text  Plain text or HTML
 * @param {string} [parseMode]  'HTML' | 'Markdown' (optional)
 * @param {object} [replyMarkup]  Inline keyboard or reply markup (optional)
 */
function sendTelegramMessage(chatId, text, parseMode = 'HTML', replyMarkup = null) {
  if (!BOT_TOKEN || !chatId) return Promise.resolve();

  return new Promise((resolve) => {
    const payload = { chat_id: String(chatId), text, parse_mode: parseMode };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const body = JSON.stringify(payload);
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve()); // swallow
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

/**
 * Notify a player (uses their Telegram user_id as the chat_id).
 * @param {string|bigint} userId
 * @param {string} message
 * @param {object} [replyMarkup]
 */
async function notifyUser(userId, message, replyMarkup = null) {
  try {
    await sendTelegramMessage(String(userId), message, 'HTML', replyMarkup);
  } catch (_) { /* non-fatal */ }
}

/**
 * Notify all admins (sends to ADMIN_CHAT_ID).
 * @param {string} message
 * @param {object} [replyMarkup]
 */
async function notifyAdmin(message, replyMarkup = null) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await sendTelegramMessage(ADMIN_CHAT_ID, message, 'HTML', replyMarkup);
  } catch (_) { /* non-fatal */ }
}

module.exports = { notifyUser, notifyAdmin, sendTelegramMessage };
