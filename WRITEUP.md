# Wallet Transfer Write-Up

## Data Model

The service stores wallets in Postgres with a UUID primary key, a unique `user_id`, and integer `balance_paise` guarded by `check (balance_paise >= 0)`. Transfers are stored with a UUID primary key, unique `idempotency_key`, request hash, source/destination wallet ids, integer `amount_paise`, and status.

`POST /admin/seed` is protected by `X-Admin-Token` and exists only to make live probe setup repeatable on the deployed URL: `https://wallet-service-re06.onrender.com`.

## Correctness Mechanism

Wallet get-or-create uses the database unique constraint on `wallets.user_id` plus `INSERT ... ON CONFLICT`, so concurrent creates for one user return one wallet.

Transfers run in one Postgres transaction. The service takes a transaction-scoped advisory lock on the idempotency key, checks any existing transfer with that key, and returns the original result for same-body retries. A same-key different-body replay returns `409`. For a new transfer, both wallet rows are locked with `SELECT ... FOR UPDATE ORDER BY id`, which gives a deterministic lock order and avoids A-to-B/B-to-A deadlocks. The balance check, debit, credit, transfer row insert, and idempotency record all commit together. If funds are insufficient, the transfer is committed as `declined_insufficient_funds` without changing balances.

I chose sorted row locks because they are simple and explicit for a two-wallet transfer. I rejected app-level read/subtract/write because it loses updates under concurrency. I rejected serializable isolation as the default because it would require retry loops for normal contention without making this small critical section clearer.

## Consistency vs Availability

For money movement, the service favors consistency. If Postgres is unavailable, transfers fail rather than accepting work that might later double-apply or violate conservation. This gives up availability during database failure, which is the right tradeoff for balances.

## Observability

Logs are structured JSON with `correlation_id`. Domain events include wallet get/create, admin seed, transfer created, debited, credited, declined, idempotent replay, and idempotency conflict. `/metrics` exposes request counters, latency histogram buckets suitable for p99, error counters, and domain counters for transfers created, declined-insufficient-funds, and idempotent replays. Recent logs are available through the Render dashboard for service `srv-dajdn9vqj5pc73d7jnq0` or with `render2 logs --resources srv-dajdn9vqj5pc73d7jnq0`.

## AI Disclosure And Cost

I directed the phased approach, deployment target, and correctness choices from the exercise/rubric. AI helped type the service scaffold, Docker/Compose setup, scripts, and documentation under those constraints. Free-tier cost target is ₹0 using Render Free Web Service and Render Free Postgres. Render free services can spin down when idle, and this Render free Postgres database expires on 2026-10-13.
