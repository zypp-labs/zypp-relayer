# Zypp Relayer Network (ZRN)

A reliability layer for Solana that enables **asynchronous transaction settlement**. ZRN accepts signed serialized transactions, queues them for processing, broadcasts them to Solana RPC nodes, and ensures confirmation through structured retry logic and status tracking.

Built for offline-first applications, mobile-first wallets, and any system that needs resilient transaction broadcasting under unstable connectivity.

**Zypp Labs**

---

## Features

- **Non-custodial** — Only transports and broadcasts fully signed payloads; never holds keys or constructs transactions
- **Resilient** — Bounded retries with exponential backoff; multi-RPC failover
- **Observable** — Job status (queued → sent → confirmed/failed), retry counts, audit log
- **Scalable** — Horizontally scalable API and workers; Redis queue; configurable concurrency

---

## Quick start

**Requirements:** Node 20+, PostgreSQL, Redis

1. **Install and set environment**

   ```bash
   npm install
   cp .env.example .env   # then edit DATABASE_URL, RPC_URLS
   ```

2. **Run Postgres and Redis** (e.g. Docker)

   ```bash
   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
   docker run -d -p 6379:6379 redis:7
   ```

3. **Migrate and start**

   ```bash
   npm run migrate
   npm run dev:api      # terminal 1
   npm run dev:worker   # terminal 2
   ```

4. **Submit a transaction**

   ```bash
   curl -X POST http://localhost:3000/v1/transactions \
     -H "Content-Type: application/json" \
     -d '{"transaction":"<base64-serialized-signed-tx>"}'
   # → 202 { "jobId": "...", "status": "queued" }

   curl http://localhost:3000/v1/transactions/<jobId>
   # → { "jobId", "status", "txSignature?", "retryCount", ... }
   ```

---

## Project structure

```
zrn/
├── src/
│   ├── api/           # HTTP API (Fastify), routes, health
│   ├── worker/        # BullMQ worker, broadcast + confirm, error classification
│   ├── queue/         # BullMQ queue and Redis connection
│   ├── store/         # PostgreSQL jobs, audit log, migrations
│   └── lib/           # Config (Zod), logger, validation, constants
├── migrations/        # SQL migrations
├── scripts/           # Benchmark script
├── docs/              # OpenAPI spec, runbook
├── Dockerfile        # API image for Fly.io
└── fly.toml          # Fly.io app config
```

---

## API overview

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/transactions` | Submit a base64 serialized signed transaction → `202` with `jobId` |
| GET | `/v1/transactions/:jobId` | Get job status, signature, retry count, error |
| GET | `/health` | Health check (DB, Redis) → `200` or `503` |

Validation: max 1232 bytes, valid Solana tx, signatures present. Duplicate payloads return `409` with existing `jobId`. Rate limiting per IP (Redis-backed).

Full API spec: [docs/openapi.yaml](docs/openapi.yaml)

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run API (production) |
| `npm run worker` | Run broadcaster worker |
| `npm run dev:api` | Run API with watch |
| `npm run dev:worker` | Run worker with watch |
| `npm run migrate` | Run PostgreSQL migrations |
| `npm run bench` | Benchmark: submit N txs, report success rate and latency (see [docs/RUNBOOK.txt](docs/RUNBOOK.txt)) |
| `npm run typecheck` | TypeScript check |

---

## Configuration

Key environment variables (see [docs/RUNBOOK.txt](docs/RUNBOOK.txt) for the full table):

- **`DATABASE_URL`** — PostgreSQL connection string (required)
- **`REDIS_URL`** — Redis URL (default `redis://localhost:6379`)
- **`RPC_URLS`** — Comma-separated Solana RPC URLs (required; e.g. `https://api.devnet.solana.com`)
- **`RATE_LIMIT_MAX`** / **`RATE_LIMIT_WINDOW_MS`** — Per-IP rate limit
- **`BULL_CONCURRENCY`** / **`BULL_MAX_ATTEMPTS`** / **`BULL_BACKOFF_MS`** — Worker concurrency and retry

---

## Deploy (Fly.io)

```bash
fly secrets set DATABASE_URL="..." REDIS_URL="..." RPC_URLS="https://api.devnet.solana.com"
fly deploy
```

Migrations run automatically via `release_command` in `fly.toml`. See [docs/RUNBOOK.txt](docs/RUNBOOK.txt) for details.

---

## License

Private. Zypp Labs.
