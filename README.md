# Wallet Service

Phase 1 skeleton for the Paytm PML wallet transfer exercise.

This phase exposes the final API routes with schema-compatible stub responses, plus real operational plumbing: Docker, Postgres health, structured JSON logs, correlation IDs, and Prometheus metrics. Phase 2 will replace the stub internals with transactional wallet and transfer logic.

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

- `POST /wallets` returns a deterministic stub wallet for the bearer token.
- `GET /wallets/:id` returns a stub zero balance.
- `POST /transfers` validates the request shape and returns a deterministic stub transfer.
- `GET /transfers/:id` returns a stub transfer status.
- `GET /healthz` verifies the service and database connection.
- `GET /metrics` exposes Prometheus metrics.

## Render Deployment

The repository includes `render.yaml` for Render Blueprint deployment:

1. Push this repository to GitHub.
2. In Render, create a new Blueprint from the repo.
3. Render will create a free web service and a free Postgres database.
4. After deployment, verify `/healthz` and `/metrics`.
5. Run `BASE_URL=https://your-render-url bash scripts/smoke.sh`.

Free-tier note: Render free web services can spin down after idle time, and free Render Postgres databases expire after 30 days.
