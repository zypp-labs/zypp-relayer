# Zypp Relayer Network (ZRN)

A reliability layer for Solana that enables **asynchronous transaction settlement**.

Zypp Relayer Network (ZRN) is the backend infrastructure component built by Zypp Labs. It accepts signed serialized transactions, queues them for processing, broadcasts them to Solana RPC nodes, and ensures confirmation through structured retry logic and status tracking.

## What is Zypp Relayer Network?

ZRN allows applications to offload the complexity of transaction broadcasting and confirmation. Instead of failing when connectivity drops or RPCs are unstable, transactions are:

- Queued securely upon receipt
- Broadcasted with multi-RPC failover
- Tracked for confirmation or failure with bounded retries

This acts as the critical backbone for offline-first applications like Zypp Pay, making digital payments reliable in real-world conditions, not just ideal ones.

## Core Features

- **Non-custodial:** Only transports and broadcasts fully signed payloads; never holds keys or constructs transactions.
- **Resilient:** Bounded retries with exponential backoff and multi-RPC failover.
- **Observable:** Real-time job status tracking (queued → sent → confirmed/failed), retry counts, and audit logs.
- **Scalable:** Horizontally scalable API and workers using Redis queues and configurable concurrency.
- **Gasless Experience Support:** Facilitates intent-based and sponsored transactions for end users.

## Where it Works Best

ZRN is designed to power:

- Offline-first applications (like Zypp Pay)
- Mobile-first wallets
- High-throughput payment systems
- Any system requiring resilient transaction broadcasting under unstable connectivity

## Architecture (High-Level)

ZRN operates through:

- **API Server:** A Fastify-based REST API that ingests and validates signed transactions and intents.
- **Queue System:** A Redis-backed BullMQ system that manages job states and retries.
- **Worker Nodes:** Dedicated processes that handle the actual broadcasting to Solana RPCs and confirmation polling.
- **Database:** A Supabase (PostgreSQL) database that stores job statuses, audit logs, and operational metrics.

_Note: The core infrastructure and relayer system are proprietary and not open source._

## Security

- **Stateless Validation:** Validates payloads strictly (max 1232 bytes, valid Solana tx, signatures present).
- **Replay Protection:** Duplicate payloads and nonces are actively rejected.
- **Rate Limiting:** Built-in Redis-backed rate limiting per IP to prevent abuse.
- **API Key Protection:** Endpoints are secured via `x-relayer-api-key`.

## Status

Zypp Relayer Network is currently:

- Fully built and integrated with Zypp Pay
- Handling workloads on Solana devnet
- Preparing for mainnet deployment

## Built by Zypp Labs

Zypp Labs is building infrastructure for offline-first financial systems, making digital payments accessible regardless of connectivity.

## Follow the Journey

Stay updated as we push the boundaries of payments:

- **X (Twitter):** [https://x.com/use_zypp](https://x.com/use_zypp)

---

## Developer Guide

### Quick start

**Requirements:** Node 20+, Supabase (PostgreSQL), Redis

1. **Install and set environment**

   ```bash
   npm install
   cp .env.example .env   # then edit DATABASE_URL, RPC_URLS, etc.
   ```

2. **Run Redis** (e.g. Docker)

   ```bash
   docker run -d -p 6379:6379 redis:7
   # Note: PostgreSQL is managed via Supabase. Run the SQL from migrations/ in your Supabase dashboard.
   ```

3. **Start API and Worker**

   ```bash
   npm run dev:api      # terminal 1
   npm run dev:worker   # terminal 2
   ```

### API overview

| Method | Path                      | Description                                                          |
| ------ | ------------------------- | -------------------------------------------------------------------- |
| POST   | `/v1/intents`             | Submit a base64 serialized signed intent bundle → `202` with `jobId` |
| POST   | `/v1/transactions`        | Submit a base64 serialized signed transaction → `202`                |
| GET    | `/v1/transactions/:jobId` | Get job status, signature, retry count, error                        |
| GET    | `/health`                 | Health check (DB, Redis) → `200` or `503`                            |
| GET    | `/v1/ops/metrics`         | Returns operational and economic metrics                             |

Full API spec: `docs/openapi.yaml`

### Scripts

| Command              | Description                   |
| -------------------- | ----------------------------- |
| `npm run build`      | Compile TypeScript to `dist/` |
| `npm start`          | Run API (production)          |
| `npm run worker`     | Run broadcaster worker        |
| `npm run dev:api`    | Run API with watch            |
| `npm run dev:worker` | Run worker with watch         |
| `npm run typecheck`  | TypeScript check              |
| `npm run lint`       | ESLint check                  |
| `npm run test`       | Run unit tests                |
