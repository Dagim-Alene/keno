'use strict';

/**
 * logger.js
 * Structured JSON logging with automated redaction of sensitive credentials and seeds.
 */

const SENSITIVE_KEYS = new Set([
  'token',
  'bot_token',
  'telegram_bot_token',
  'admin_token',
  'secret',
  'payment_webhook_secret',
  'session_secret',
  'password',
  'authorization',
  'server_seed',
  'serverseed',
  'initdata',
  'x-telegram-init-data',
  'x-admin-token',
]);

function redact(obj, depth = 0) {
  if (depth > 5 || obj == null) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => redact(item, depth + 1));
  }

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = redact(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...redact(meta),
  };
  const json = JSON.stringify(entry);
  if (level === 'error') {
    console.error(json);
  } else if (level === 'warn') {
    console.warn(json);
  } else {
    console.log(json);
  }
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  redact,
};
