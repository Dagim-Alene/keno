'use strict';

/**
 * scripts/migrate.js
 * Runs all SQL migration files in /migrations in order.
 * Usage: node scripts/migrate.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('[migrate] Connected to database');

  try {
    // Bootstrap migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM _migrations WHERE filename = $1',
        [file]
      );
      if (rows.length > 0) {
        console.log(`[migrate] Already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`[migrate] Applying: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] ✓ ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ✗ ${file}: ${err.message}`);
        throw err;
      }
    }

    console.log('[migrate] All migrations applied successfully.');
  } finally {
    await client.end();
  }
}

migrate().catch(err => {
  console.error('[migrate] Fatal:', err.message);
  process.exit(1);
});
