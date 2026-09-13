import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { checkDatabase } from "../db.js";
import { register } from "../metrics.js";

export function registerSystemRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get("/healthz", async (_request, reply) => {
    try {
      await checkDatabase(pool);
      return { status: "ok", database: "ok" };
    } catch (error) {
      app.log.error({ err: error }, "database health check failed");
      return reply.code(503).send({ status: "degraded", database: "error" });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
}
