import client from "prom-client";
import type { FastifyInstance } from "fastify";

export const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"]
});

export const httpErrorsTotal = new client.Counter({
  name: "http_errors_total",
  help: "Total HTTP 5xx responses",
  labelNames: ["method", "route", "status_code"]
});

export const transfersCreatedTotal = new client.Counter({
  name: "wallet_transfers_created_total",
  help: "Transfers accepted by the service"
});

export const transfersDeclinedInsufficientFundsTotal = new client.Counter({
  name: "wallet_transfers_declined_insufficient_funds_total",
  help: "Transfers declined because the sender had insufficient funds"
});

export const idempotentReplaysTotal = new client.Counter({
  name: "wallet_idempotent_replays_total",
  help: "Transfer requests served from an idempotency replay"
});

register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsTotal);
register.registerMetric(httpErrorsTotal);
register.registerMetric(transfersCreatedTotal);
register.registerMetric(transfersDeclinedInsufficientFundsTotal);
register.registerMetric(idempotentReplaysTotal);

export function installMetricsHooks(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    request.startTime = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = request.startTime;
    if (!startedAt) {
      return;
    }

    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? request.url,
      status_code: String(reply.statusCode)
    };

    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);

    if (reply.statusCode >= 500) {
      httpErrorsTotal.inc(labels);
    }
  });
}
