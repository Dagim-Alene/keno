'use strict';

/**
 * server.js
 * Keno Telegram Mini App — production server.
 *
 * API routes are IDENTICAL to the original in-memory version so that
 * public/index.html continues to work without changes.
 *
 * Differences from the original:
 *   - In-memory state replaced with PostgreSQL (wallet.js + services/)
 *   - helmet for HTTP security headers
 *   - Telegram initData validation (middleware/telegram.js)
 *   - Rate limiting on /api/play
 *   - All secrets from environment variables (.env)
 */

require('dotenv').config();

// Production security guard: DEV_MODE cannot be enabled when NODE_ENV=production
if (process.env.NODE_ENV === 'production' && (process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1')) {
  console.error('FATAL: DEV_MODE cannot be enabled when NODE_ENV=production');
  process.exit(1);
}

const express   = require('express');
const path      = require('path');
const helmet    = require('helmet');

const telegramAuth = require('./middleware/telegram');

// Route modules
const stateRouter    = require('./routes/state');
const playRouter     = require('./routes/play');
const fairnessRouter = require('./routes/fairness');
const userRouter     = require('./routes/user');
const paymentsRouter = require('./routes/payments');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  // Allow the Telegram WebApp script
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'telegram.org', '*.telegram.org'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com'],
      connectSrc:  ["'self'"],
      imgSrc:      ["'self'", 'data:'],
    },
  },
}));

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------
// Raw body needed for payment webhook HMAC — mount before json()
app.use('/webhooks/payments', express.raw({ type: '*/*' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Static files (public/index.html)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Telegram auth middleware (sets req.userId on all /api/* routes)
// ---------------------------------------------------------------------------
app.use(telegramAuth);

// ---------------------------------------------------------------------------
// API Routes (same paths as original server.js)
// ---------------------------------------------------------------------------
app.use('/api',             stateRouter);    // GET /api/state, GET /api/history
app.use('/api/play',        playRouter);     // POST /api/play
app.use('/api/fairness',    fairnessRouter); // POST /api/fairness/rotate, POST /api/fairness/client-seed
app.use('/api/user',        userRouter);     // POST /api/user/limits, POST /api/user/self-exclude
app.use('/',                paymentsRouter); // POST /api/deposit/create, POST /webhooks/payments, etc.

// ---------------------------------------------------------------------------
// 404 and error handlers
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Keno mini app running at http://0.0.0.0:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log('Development mode: use X-Dev-User-Id header to set user ID');
    }
  });
}

module.exports = app;
