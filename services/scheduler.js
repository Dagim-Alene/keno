'use strict';

/**
 * services/scheduler.js
 * Continuous live Keno round scheduler using PostgreSQL advisory lock.
 * Manages the BETTING -> LOCKED -> DRAWING -> RESULT -> SETTLED round lifecycle.
 * Survives restarts and crash recovery.
 */

const crypto = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const { generateDrawnNumbers, sha256 } = require('./draw');
const { settleRound, voidRound } = require('./settlement');
const { broadcast } = require('./sse');

const ADVISORY_LOCK_ID = 42424242;

// Default timing configuration (seconds)
const DEFAULT_BETTING_S = 25;
const DEFAULT_LOCKED_S  = 3;
const DEFAULT_DRAWING_S = 10;
const DEFAULT_RESULT_S  = 5;

class RoundScheduler {
  constructor(options = {}) {
    this.lockId = options.lockId || ADVISORY_LOCK_ID;
    this.getNow = options.getNow || (() => Date.now());
    this.isRunning = false;
    this.hasLock = false;
    this.currentRound = null;
    this.timer = null;
    this.ballInterval = null;
    this.standbyTimer = null;
    this.client = null; // dedicated client for advisory lock
    this.onPhaseChange = options.onPhaseChange || null;
  }

  async loadConfig() {
    try {
      const { rows } = await pool.query(
        `SELECT key, value FROM game_config
         WHERE key IN ('betting_duration_s', 'locked_duration_s', 'drawing_duration_s', 'result_duration_s', 'game_paused')`
      );
      const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
      return {
        bettingDurationS: Number(process.env.BETTING_DURATION_S || map.betting_duration_s || DEFAULT_BETTING_S),
        lockedDurationS:  Number(process.env.LOCKED_DURATION_S  || map.locked_duration_s  || DEFAULT_LOCKED_S),
        drawingDurationS: Number(process.env.DRAWING_DURATION_S || map.drawing_duration_s || DEFAULT_DRAWING_S),
        resultDurationS:  Number(process.env.RESULT_DURATION_S  || map.result_duration_s  || DEFAULT_RESULT_S),
        paused:           (map.game_paused === 'true'),
      };
    } catch {
      return {
        bettingDurationS: DEFAULT_BETTING_S,
        lockedDurationS:  DEFAULT_LOCKED_S,
        drawingDurationS: DEFAULT_DRAWING_S,
        resultDurationS:  DEFAULT_RESULT_S,
        paused:           false,
      };
    }
  }

  async acquireLock() {
    this.client = await pool.connect();
    const { rows } = await this.client.query('SELECT pg_try_advisory_lock($1) AS locked', [this.lockId]);
    this.hasLock = rows[0]?.locked === true;
    if (!this.hasLock) {
      this.client.release();
      this.client = null;
    }
    return this.hasLock;
  }

  async releaseLock() {
    if (this.client && this.hasLock) {
      try {
        await this.client.query('SELECT pg_advisory_unlock($1)', [this.lockId]);
      } catch (_) {}
      this.client.release();
      this.client = null;
      this.hasLock = false;
    }
  }

  async recoverOnBoot() {
    // Check latest round
    const { rows } = await pool.query(
      `SELECT * FROM live_rounds ORDER BY round_number DESC LIMIT 1`
    );
    if (rows.length === 0) {
      return null;
    }

    const latest = rows[0];

    // If latest round already settled or void, nothing to recover
    if (latest.status === 'settled' || latest.status === 'void') {
      return latest;
    }

    const now = this.getNow();
    const resultStarts = new Date(latest.result_starts_at).getTime();
    const bettingCloses = new Date(latest.betting_closes_at).getTime();

    // If the round is still actively in its betting window, resume it
    if (latest.status === 'betting' && now < bettingCloses) {
      this.currentRound = {
        ...latest,
        serverSeed: latest.server_seed,
        drawn: latest.drawn,
      };
      return latest;
    }

    // If the round died during drawing or result, or after result_starts_at
    if (now >= resultStarts || latest.status === 'drawing' || latest.status === 'result') {
      console.log(`[scheduler] Recovering round #${latest.round_number} (status: ${latest.status})`);
      try {
        // Deterministically compute draw if missing
        let drawn = latest.drawn;
        let serverSeed = latest.server_seed;
        if (!drawn || !serverSeed) {
          if (!serverSeed) {
            console.warn(`[scheduler] Round #${latest.round_number} missing server_seed on crash. Voiding & refunding.`);
            await voidRound(latest.id);
            return latest;
          }
        }
        await settleRound(latest.id, drawn, serverSeed);
      } catch (err) {
        console.error(`[scheduler] Recovery error on round #${latest.round_number}:`, err);
        await voidRound(latest.id);
      }
      return latest;
    }

    // If the round expired while the server was offline during betting or locked phase
    if (now >= bettingCloses && (latest.status === 'betting' || latest.status === 'locked')) {
      console.log(`[scheduler] Round #${latest.round_number} expired while server was offline (status: ${latest.status}). Voiding & refunding.`);
      await voidRound(latest.id);
      return latest;
    }

    return latest;
  }

  async createNewRound(roundNumber, prevRoundHash = null) {
    const config = await this.loadConfig();
    if (config.paused) {
      console.log('[scheduler] Game paused: skipping new round creation');
      broadcast('round:paused', { paused: true, serverTime: this.getNow() });
      return null;
    }

    const now = this.getNow();
    const bettingOpens = new Date(now);
    const bettingCloses = new Date(now + config.bettingDurationS * 1000);
    const drawStarts = new Date(bettingCloses.getTime() + config.lockedDurationS * 1000);
    const resultStarts = new Date(drawStarts.getTime() + config.drawingDurationS * 1000);

    const serverSeed = crypto.randomBytes(32).toString('hex');
    const serverSeedHash = sha256(serverSeed);

    // Compute deterministic draw right away for internal use
    const drawn = generateDrawnNumbers(serverSeed, String(roundNumber), 0);

    const { rows } = await pool.query(
      `INSERT INTO live_rounds
         (round_number, status, server_seed_hash, prev_round_hash, drawn,
          betting_opens_at, betting_closes_at, draw_starts_at, result_starts_at)
       VALUES ($1, 'betting', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [roundNumber, serverSeedHash, prevRoundHash, drawn, bettingOpens, bettingCloses, drawStarts, resultStarts]
    );

    const roundRow = rows[0];
    this.currentRound = {
      ...roundRow,
      serverSeed, // kept in memory until settled
      drawn,
    };

    broadcast('round:new', {
      round: this.formatRoundForPublic(this.currentRound),
      serverTime: now,
    });

    return this.currentRound;
  }

  formatRoundForPublic(r) {
    if (!r) return null;
    const roundNumber = r.roundNumber !== undefined ? Number(r.roundNumber) : Number(r.round_number);
    const serverSeedHash = r.serverSeedHash || r.server_seed_hash;
    const prevRoundHash = r.prevRoundHash || r.prev_round_hash || null;
    const serverSeed = (r.status === 'settled') ? (r.serverSeed || r.server_seed) : null;
    const drawn = (r.status === 'drawing' || r.status === 'result' || r.status === 'settled') ? r.drawn : null;
    const bettingOpensAt = r.bettingOpensAt || (r.betting_opens_at ? new Date(r.betting_opens_at).toISOString() : null);
    const bettingClosesAt = r.bettingClosesAt || (r.betting_closes_at ? new Date(r.betting_closes_at).toISOString() : null);
    const drawStartsAt = r.drawStartsAt || (r.draw_starts_at ? new Date(r.draw_starts_at).toISOString() : null);
    const resultStartsAt = r.resultStartsAt || (r.result_starts_at ? new Date(r.result_starts_at).toISOString() : null);
    const settledAt = r.settledAt || (r.settled_at ? new Date(r.settled_at).toISOString() : null);

    return {
      id: String(r.id),
      roundNumber,
      status: r.status,
      serverSeedHash,
      prevRoundHash,
      serverSeed,
      drawn,
      bettingOpensAt,
      bettingClosesAt,
      drawStartsAt,
      resultStartsAt,
      settledAt,
    };
  }

  async runCycle() {
    if (!this.hasLock) return;

    try {
      const config = await this.loadConfig();
      if (!this.currentRound) {
        if (config.paused) {
          this.scheduleNextTick(2000);
          return;
        }
        // Determine round number from last round
        const { rows } = await pool.query('SELECT round_number, server_seed FROM live_rounds ORDER BY round_number DESC LIMIT 1');
        const lastNum = rows.length ? Number(rows[0].round_number) : 0;
        const prevSeed = rows.length ? rows[0].server_seed : null;
        const prevHash = prevSeed ? sha256(prevSeed) : null;
        await this.createNewRound(lastNum + 1, prevHash);
      }

      if (!this.currentRound) {
        this.scheduleNextTick(2000);
        return;
      }

      const now = this.getNow();
      const r = this.currentRound;
      const bettingCloses = new Date(r.betting_closes_at).getTime();
      const drawStarts    = new Date(r.draw_starts_at).getTime();
      const resultStarts  = new Date(r.result_starts_at).getTime();
      const roundEnds     = resultStarts + (config.resultDurationS * 1000);

      // Phase 1: BETTING -> LOCKED
      if (r.status === 'betting' && now >= bettingCloses) {
        r.status = 'locked';
        await pool.query('UPDATE live_rounds SET status = $1 WHERE id = $2', ['locked', r.id]);
        broadcast('round:phase', {
          id: String(r.id),
          roundNumber: Number(r.round_number),
          status: 'locked',
          serverTime: now,
        });
        if (this.onPhaseChange) this.onPhaseChange('locked', r);
      }

      // Phase 2: LOCKED -> DRAWING
      if (r.status === 'locked' && now >= drawStarts) {
        r.status = 'drawing';
        await pool.query('UPDATE live_rounds SET status = $1 WHERE id = $2', ['drawing', r.id]);
        broadcast('round:phase', {
          id: String(r.id),
          roundNumber: Number(r.round_number),
          status: 'drawing',
          drawn: r.drawn,
          serverTime: now,
        });
        if (this.onPhaseChange) this.onPhaseChange('drawing', r);

        // Start progressive ball reveals if not running instant clock
        this.startBallBroadcast(r, drawStarts, resultStarts);
      }

      // Phase 3: DRAWING -> RESULT
      if (r.status === 'drawing' && now >= resultStarts) {
        this.stopBallBroadcast();
        r.status = 'result';
        await pool.query('UPDATE live_rounds SET status = $1 WHERE id = $2', ['result', r.id]);

        // Run settlement immediately at result phase
        const { settledCount, totalPayout } = await settleRound(r.id, r.drawn, r.serverSeed);
        r.status = 'settled';
        r.server_seed = r.serverSeed;

        broadcast('round:result', {
          id: String(r.id),
          roundNumber: Number(r.round_number),
          status: 'settled',
          drawn: r.drawn,
          serverSeed: r.serverSeed,
          serverSeedHash: r.server_seed_hash,
          settledCount,
          totalPayout: Number(totalPayout),
          serverTime: now,
        });
        if (this.onPhaseChange) this.onPhaseChange('result', r);
      }

      // Phase 4: RESULT / SETTLED complete -> NEXT ROUND
      if (r.status === 'settled' && now >= roundEnds) {
        const nextNum = Number(r.round_number) + 1;
        const prevHash = sha256(r.serverSeed);
        this.currentRound = null;
        await this.createNewRound(nextNum, prevHash);
      }

    } catch (err) {
      console.error('[scheduler] Error in runCycle:', err);
    }

    if (this.isRunning) {
      this.scheduleNextTick(500);
    }
  }

  startBallBroadcast(r, drawStarts, resultStarts) {
    this.stopBallBroadcast();
    const duration = Math.max(1000, resultStarts - drawStarts);
    const intervalMs = Math.floor(duration / 20);
    let ballIdx = 0;

    this.ballInterval = setInterval(() => {
      if (!this.isRunning || r.status !== 'drawing' || ballIdx >= 20) {
        this.stopBallBroadcast();
        return;
      }
      const ball = r.drawn[ballIdx];
      ballIdx++;
      broadcast('round:ball', {
        roundNumber: Number(r.round_number),
        index: ballIdx - 1,
        total: 20,
        ball,
        serverTime: this.getNow(),
      });
    }, intervalMs);
    if (this.ballInterval && this.ballInterval.unref) this.ballInterval.unref();
  }

  stopBallBroadcast() {
    if (this.ballInterval) {
      clearInterval(this.ballInterval);
      this.ballInterval = null;
    }
  }

  scheduleNextTick(delayMs = 500) {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => this.runCycle(), delayMs);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.tryAcquireAndRun();
  }

  async tryAcquireAndRun() {
    if (!this.isRunning) return;
    if (this.hasLock) return;

    const locked = await this.acquireLock();
    if (!locked) {
      console.log('[scheduler] Advisory lock already held by another instance. Standing by as passive replica.');
      if (!this.standbyTimer) {
        this.standbyTimer = setInterval(async () => {
          if (!this.isRunning) {
            clearInterval(this.standbyTimer);
            this.standbyTimer = null;
            return;
          }
          if (await this.acquireLock()) {
            clearInterval(this.standbyTimer);
            this.standbyTimer = null;
            console.log('[scheduler] Advisory lock acquired (42424242). Active scheduler started.');
            await this.recoverOnBoot();
            await this.runCycle();
          }
        }, 2000);
        if (this.standbyTimer.unref) this.standbyTimer.unref();
      }
      return;
    }

    if (this.standbyTimer) {
      clearInterval(this.standbyTimer);
      this.standbyTimer = null;
    }
    console.log('[scheduler] Advisory lock acquired (42424242). Active scheduler started.');

    await this.recoverOnBoot();
    await this.runCycle();
  }

  async stop() {
    this.isRunning = false;
    if (this.standbyTimer) {
      clearInterval(this.standbyTimer);
      this.standbyTimer = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopBallBroadcast();
    await this.releaseLock();
    console.log('[scheduler] Scheduler stopped.');
  }

  getStatus() {
    return {
      running: this.isRunning,
      hasLock: this.hasLock,
      currentRound: this.formatRoundForPublic(this.currentRound),
      serverTime: this.getNow(),
    };
  }
}

// Global singleton instance
let instance = null;

function getScheduler(options = {}) {
  if (!instance) {
    instance = new RoundScheduler(options);
  }
  return instance;
}

module.exports = { RoundScheduler, getScheduler };
