'use strict';

/**
 * scripts/stop-db.js
 * Stops the local dedicated PostgreSQL cluster on port 5433.
 */

const { execSync } = require('child_process');
const path = require('path');

const pgData = path.join(__dirname, '..', '.pgdata');
const pgCtl = 'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_ctl.exe';

try {
  execSync(`"${pgCtl}" -D "${pgData}" stop -m fast`, { stdio: 'inherit' });
  console.log('[db] PostgreSQL stopped.');
} catch (err) {
  console.log('[db] Server was not running or failed to stop:', err.message);
}
