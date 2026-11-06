'use strict';

/**
 * server.js
 * Keno Telegram Mini App — production server.
 * Supports both Live Shared Rounds (SSE + scheduler) and classic solo play endpoints.
 */

require('dotenv').config();
const logger = require('./logger');

// Production security guards
if (process.env.NODE_ENV === 'production') {
  if (process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1') {
    logger.error('FATAL: DEV_MODE cannot be enabled when NODE_ENV=production');
    process.exit(1);
  }
  const requiredEnv = ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'ADMIN_TOKEN'];
  for (const envKey of requiredEnv) {
    if (!process.env[envKey]) {
      logger.error(`FATAL: ${envKey} must be configured in production`);
      process.exit(1);
    }
  }
}

const express   = require('express');
const path      = require('path');
const helmet    = require('helmet');

const telegramAuth   = require('./middleware/telegram');
const { getScheduler } = require('./services/scheduler');

// Route modules
const stateRouter    = require('./routes/state');
const playRouter     = require('./routes/play');
const fairnessRouter = require('./routes/fairness');
const userRouter     = require('./routes/user');
const paymentsRouter = require('./routes/payments');
const liveRouter     = require('./routes/live');
const ticketsRouter  = require('./routes/tickets');
const roundsRouter   = require('./routes/rounds');
const healthRouter   = require('./routes/health');
const adminRouter    = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust proxy configuration
// Unset / empty = trust nothing (false)
// "1", "2", etc. = trust n hops
// "true" / "loopback" / etc. = trust configured proxies
// Invalid string = trust nothing (false)
if (process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== '') {
  const val = process.env.TRUST_PROXY.trim().toLowerCase();
  if (val === 'true') {
    app.set('trust proxy', true);
  } else if (val === 'false') {
    app.set('trust proxy', false);
  } else if (/^\d+$/.test(val)) {
    app.set('trust proxy', parseInt(val, 10));
  } else if (val === 'loopback' || val === 'linklocal' || val === 'uniquelocal') {
    app.set('trust proxy', val);
  } else {
    // Invalid value -> safe default: trust nothing
    app.set('trust proxy', false);
  }
} else {
  // Unset -> trust nothing
  app.set('trust proxy', false);
}

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'telegram.org', '*.telegram.org'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc:       ["'self'", 'fonts.gstatic.com'],
      connectSrc:    ["'self'"],
      imgSrc:        ["'self'", 'data:'],
    },
  },
}));

// ---------------------------------------------------------------------------
// Health check endpoint (before auth)
// ---------------------------------------------------------------------------
app.use('/', healthRouter);

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------
// Raw body needed for payment webhook HMAC — mount before json()
app.use('/webhooks/payments', express.raw({ type: '*/*' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Static files (public/index.html, public/admin.html) with no-cache headers
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ---------------------------------------------------------------------------
// Telegram auth middleware (sets req.userId on /api/* routes)
// ---------------------------------------------------------------------------
app.use(telegramAuth);

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.use('/api',             stateRouter);    // GET /api/state, GET /api/history
app.use('/api/live',        liveRouter);     // GET /api/live (SSE & polling)
app.use('/api/tickets',     ticketsRouter);  // POST /api/tickets (place bet in live round)
app.use('/api/rounds',      roundsRouter);   // GET /api/rounds/recent, /:roundNumber
app.use('/api/play',        playRouter);     // POST /api/play (solo round compatibility)
app.use('/api/fairness',    fairnessRouter); // POST /api/fairness/rotate, /client-seed
app.use('/api/user',        userRouter);     // POST /api/user/limits, /self-exclude
app.use('/',                adminRouter);    // /admin, /admin/game/*, /api/admin/*, /api/deposit/request, /api/wallet/history
app.use('/',                paymentsRouter); // POST /api/deposit/create, POST /webhooks/payments, etc.

// ---------------------------------------------------------------------------
// 404 and error handlers
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error('Unhandled server error', { err: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error.' });
});

// ---------------------------------------------------------------------------
// Start Server & Live Round Scheduler
// ---------------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', async () => {
    logger.info(`Keno mini app running at http://0.0.0.0:${PORT}`, { port: PORT, env: process.env.NODE_ENV });
    try {
      const scheduler = getScheduler();
      await scheduler.start();
    } catch (schedErr) {
      logger.error('Failed to start live round scheduler', { error: schedErr.message });
    }
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      const scheduler = getScheduler();
      await scheduler.stop();
    } catch (_) {}
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
