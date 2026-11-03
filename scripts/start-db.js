'use strict';

/**
 * scripts/start-db.js
 * Starts the local dedicated PostgreSQL cluster on port 5433.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const pgData = path.join(__dirname, '..', '.pgdata');
const postgresExe = 'C:\\Program Files\\PostgreSQL\\18\\bin\\postgres.exe';
const initdbExe = 'C:\\Program Files\\PostgreSQL\\18\\bin\\initdb.exe';

if (!fs.existsSync(pgData)) {
  console.log('[db] Initializing database cluster in .pgdata...');
  const { execSync } = require('child_process');
  execSync(`"${initdbExe}" -D "${pgData}" -U postgres -A trust -E UTF8 --no-locale`, { stdio: 'inherit' });
}

console.log('[db] Starting PostgreSQL on port 5433...');
const child = spawn(postgresExe, ['-D', pgData, '-p', '5433'], {
  detached: true,
  stdio: 'ignore'
});
child.unref();

console.log('[db] PostgreSQL started with PID:', child.pid);
