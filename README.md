# Keno Telegram Mini App — Backend v2

Provably-fair Keno game with a PostgreSQL wallet + ledger. The visual frontend (`public/index.html`) is unchanged.

---

## Quick Start (Zero Setup — Automatic Local DB)

The repository includes a dedicated, self-contained local PostgreSQL cluster that runs without touching your main system PostgreSQL password or configuration:

```cmd
# 1. Start the dedicated PostgreSQL database (port 5433)
npm run db:start

# 2. Run migrations
npm run migrate

# 3. Start the application
npm start
```

Visit `http://localhost:3000` — the game loads immediately.

To stop the database when done:
```cmd
npm run db:stop
```

---

## Alternative Setup (Using Existing PostgreSQL or Docker)

For development (no Telegram initData required):

```cmd
npm run dev
```

Then call the API with header `X-Dev-User-Id: 12345`.

---

## API Endpoints (unchanged from v1)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/state` | Balance, seeds, paytable, limits |
| `GET`  | `/api/history` | Last 50 rounds (current user) |
| `POST` | `/api/play` | Place a bet |
| `POST` | `/api/fairness/rotate` | Rotate seed pair |
| `POST` | `/api/fairness/client-seed` | Update client seed |
| `POST` | `/api/user/limits` | Set RG limits (RG_ENABLED=true required) |
| `POST` | `/api/user/self-exclude` | Self-exclude (RG_ENABLED=true required) |

### Payment skeleton (not production-ready)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/deposit/create` | Create deposit intent |
| `POST` | `/webhooks/payments` | Payment webhook (HMAC-verified) |
| `POST` | `/api/withdraw/request` | Request withdrawal |
| `POST` | `/api/admin/withdraw/:id/approve` | Admin approve |
| `POST` | `/api/admin/withdraw/:id/reject` | Admin reject + refund |

---

## Scripts

```cmd
# Reproduce a draw (provably-fair verification)
npm run verify -- <serverSeed> <clientSeed> <nonce>

# Audit ledger integrity (sum of entries must equal wallet balance)
npm run audit

# Run all tests (pg-mem, no real DB needed)
npm test
```

---

## Architecture

```
server.js               — Express app, middleware wiring
middleware/
  telegram.js           — initData validation, sets req.userId
routes/
  state.js              — GET /api/state, GET /api/history
  play.js               — POST /api/play (rate-limited)
  fairness.js           — POST /api/fairness/*
  user.js               — POST /api/user/*
  payments.js           — deposit / withdraw / admin routes
services/
  draw.js               — HMAC-SHA256 draw (verbatim from original)
  seeds.js              — seed pair lifecycle
  keno.js               — single-transaction play round
  limits.js             — responsible-gaming checks
wallet.js               — getBalance / credit / debit (reusable)
db/
  pool.js               — pg Pool singleton + withTransaction helper
migrations/
  001_users.sql
  002_wallets.sql
  003_ledger.sql        — append-only trigger
  004_seeds.sql
  005_keno_rounds.sql
  006_withdrawals.sql
payments/
  provider.js           — mock payment provider interface
scripts/
  migrate.js
  verify.js
  audit.js
tests/
  draw.test.js
  wallet.test.js
  limits.test.js
  payments.test.js
  rtp.test.js
```

---

## Security

- `helmet` sets secure HTTP headers (including CSP allowing the Telegram SDK)
- Telegram `initData` validated with HMAC-SHA256; rejected if older than 1 hour
- `express-rate-limit` on `/api/play`: 30 requests/minute per user
- All secrets from environment variables (never hard-coded)
- Ledger is append-only at the database level (PostgreSQL trigger)
- Balance stored as `BIGINT` cents with `CHECK (balance >= 0)` constraint
- Every balance mutation runs inside `SELECT ... FOR UPDATE` transaction

---

## Responsible Gaming

`POST /api/user/limits` allows players to set their personal daily loss limit and max single bet.

### Daily Loss Limit Configuration
- `DEFAULT_DAILY_LOSS_LIMIT_CENTS`: Set in `.env`. Setting to `0` or leaving unset means **NO forced daily loss limit** by default. No player is capped unless they choose to set a personal limit or a non-zero system default is specified.
- **Regulatory Note**: Even when the default is set to `0`, responsible gaming tools remain active and accessible via `POST /api/user/limits` so that players can set voluntary limits as required by regulators.
- Self-exclusion (`POST /api/user/self-exclude`), age verification, max single bet, per-ticket/per-round payout caps, and rate limits remain active and enforced.

---

## What is stubbed / not production-ready

| Item | Status |
|------|--------|
| Payment provider | Mock only. Wire a real provider in `payments/provider.js` |
| Responsible gaming limits | DB columns not yet added (`RG_ENABLED=false`) |
| Admin UI | REST endpoints only, no interface |
| Telegram initData | Validated correctly; test with `X-Dev-User-Id` in dev mode |
| Country blocking | Reads `CF-IPCountry` header; works behind Cloudflare only |
| Self-exclusion | Implemented; requires `RG_ENABLED=true` |

---

## Resetting the Postgres password (Windows)

If you don't know your postgres password:

1. Open `pg_hba.conf` (usually at `C:\Program Files\PostgreSQL\18\data\pg_hba.conf`)
2. Temporarily change `scram-sha-256` to `trust` for local connections
3. Restart PostgreSQL: `net stop postgresql-x64-18 && net start postgresql-x64-18`
4. Run: `psql -U postgres -c "ALTER USER postgres PASSWORD 'newpassword';"`
5. Revert `pg_hba.conf` back to `scram-sha-256` and restart again
6. Set `DATABASE_URL=postgres://postgres:newpassword@127.0.0.1:5432/keno` in `.env`
