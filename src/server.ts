import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { loadConfig, type AppConfig } from "./config.js";
import { createPool } from "./db.js";
import { installAuthHook } from "./http/auth.js";
import { installMetricsHooks } from "./metrics.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import { registerWalletRoutes } from "./routes/wallets.js";

function buildServer(config: AppConfig, pool: pg.Pool): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      formatters: {
        level(label) {
          return { level: label };
        }
      }
    },
    requestIdLogLabel: "correlation_id",
    genReqId(request) {
      const header = request.headers["x-correlation-id"];
      return typeof header === "string" && header.length > 0 ? header : crypto.randomUUID();
    }
  });

  installMetricsHooks(app);
  installAuthHook(app);
  registerSystemRoutes(app, pool);
  registerWalletRoutes(app, pool, config);
  registerTransferRoutes(app, pool);

  return app;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const app = buildServer(config, pool);

  const shutdown = async (): Promise<void> => {
    app.log.info("shutting down");
    await app.close();
    await pool.end();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
