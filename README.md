# Wallet Service

Wallet and P2P transfer API for the Paytm PML wallet transfer exercise.

The service is intentionally API-only. It uses Postgres transactions, deterministic row locks, database uniqueness constraints, structured JSON logs, correlation IDs, and Prometheus metrics.

## Local Run

```sh
cp .env.example .env
docker compose up --build
```

Smoke checks:

```sh
bash scripts/smoke.sh
```

## Phase 1 API Surface

- `POST /wallets` get-or-creates a wallet for the bearer token.
- `GET /wallets/:id` returns the current balance.
- `POST /transfers` moves integer paise between wallets using an idempotency key.
- `GET /transfers/:id` returns persisted transfer status.
- `POST /admin/seed` sets up funded test wallets when called with `X-Admin-Token`.
- `GET /healthz` verifies the service and database connection.
- `GET /metrics` exposes Prometheus metrics.

## Burst Probe

```sh
ADMIN_TOKEN=dev-admin-token bash scripts/burst.sh
```

Against a deployed service:

```sh
BASE_URL=https://your-render-url ADMIN_TOKEN=your-admin-token bash scripts/burst.sh
```

The script covers concurrent get-or-create, idempotent retry storms, same-key different-body conflict, and conservation under contention.

## Render Deployment

The repository includes `render.yaml` for Render Blueprint deployment:

1. Push this repository to GitHub.
2. In Render, create a new Blueprint from the repo.
3. Render will create a free web service and a free Postgres database.
4. After deployment, verify `/healthz` and `/metrics`.
5. Run `BASE_URL=https://your-render-url bash scripts/smoke.sh`.

Free-tier note: Render free web services can spin down after idle time, and free Render Postgres databases expire after 30 days.
