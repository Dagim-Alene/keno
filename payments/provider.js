'use strict';

/**
 * payments/provider.js
 * Skeleton interface for a payment provider.
 * Replace the mock implementation with a real provider (Stripe, etc.) when ready.
 *
 * Interface contract:
 *   createDeposit(userId, amountCents, currency)   → { paymentId, redirectUrl }
 *   verifyWebhookSignature(rawBody, signature)     → boolean
 *   getPaymentStatus(paymentId)                    → { status: 'pending'|'completed'|'failed', amountCents }
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

const _payments = new Map(); // paymentId → { userId, amountCents, currency, status }
const _depositIdempotency = new Map(); // idempotencyKey → { paymentId, redirectUrl }

/**
 * Create a deposit intent.
 * @param {bigint|number} userId
 * @param {number}        amountCents
 * @param {string}        [currency]
 * @param {string}        [idempotencyKey]
 * @returns {{ paymentId: string, redirectUrl: string }}
 */
async function createDeposit(userId, amountCents, currency = 'USD', idempotencyKey = null) {
  if (idempotencyKey && _depositIdempotency.has(idempotencyKey)) {
    return _depositIdempotency.get(idempotencyKey);
  }

  const paymentId = `mock_${crypto.randomBytes(16).toString('hex')}`;
  _payments.set(paymentId, { userId, amountCents, currency, status: 'pending' });

  const result = {
    paymentId,
    redirectUrl: `https://example.com/mock-payment?id=${paymentId}&amount=${amountCents}`,
  };

  if (idempotencyKey) {
    _depositIdempotency.set(idempotencyKey, result);
  }

  return result;
}

/**
 * Verify the HMAC-SHA256 signature on a payment webhook payload.
 * @param {Buffer|string} rawBody
 * @param {string}        signature  hex string from the provider
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET || 'dev-secret';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Get the current status of a payment.
 * @param {string} paymentId
 * @returns {{ status: string, amountCents: number, currency: string }}
 */
async function getPaymentStatus(paymentId) {
  const p = _payments.get(paymentId);
  if (!p) throw new Error(`Payment ${paymentId} not found`);
  return { status: p.status, amountCents: p.amountCents, currency: p.currency };
}

// Test-only: mark a mock payment as completed
async function _mockComplete(paymentId) {
  const p = _payments.get(paymentId);
  if (p) p.status = 'completed';
}

module.exports = { createDeposit, verifyWebhookSignature, getPaymentStatus, _mockComplete };
