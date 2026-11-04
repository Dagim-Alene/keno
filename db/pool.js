'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// pool is created lazily on first access so that test files can
// set process.env.DATABASE_URL (or monkey-patch this module) before
// any pool connection is attempted.
let _pool = null;

function getPool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL environment variable is required. ' +
        'Copy .env.example to .env and fill it in.'
      );
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    _pool.on('error', (err) => {
      console.error('[db/pool] Unexpected client error:', err.message);
    });
  }
  return _pool;
}

// Tests can replace this entire module export:
//   require('../db/pool').pool = myInMemoryPool;
// Because module.exports is an object, mutating its properties works.
const exports_ = {
  get pool() {
    if (_pool && (_pool.ending || _pool.ended)) {
      _pool = null;
    }
    return _pool || getPool();
  },
  set pool(p) { _pool = p; },

  get withTransaction() {
    return exports_._withTransaction;
  },
  set withTransaction(fn) {
    exports_._withTransaction = fn;
  },

  _withTransaction: async function withTransaction(fn, isolationLevel = 'READ COMMITTED') {
    const client = await exports_.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = exports_;
