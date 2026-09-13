import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { loadConfig, type AppConfig } from "./config.js";
import { checkDatabase, createPool } from "./db.js";
import { installMetricsHooks, register, transfersCreatedTotal } from "./metrics.js";

type CreateWalletReply = {
  wallet_id: string;
  user_id: string;
  balance_paise: number;
};

type WalletReply = {
  wallet_id: string;
  balance_paise: number;
};

type CreateTransferBody = {
  from: string;
  to: string;
  amount_paise: number;
  idempotency_key: string;
};

type TransferReply = {
  transfer_id: string;
  from: string;
  to: string;
  amount_paise: number;
  idempotency_key: string;
  status: "succeeded" | "declined_insufficient_funds" | "pending";
};

function stableId(prefix: string, value: string): string {
  const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readBearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "missing_bearer_token" });
    return;
  }

  request.userId = token;
}

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

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/metrics") {
      return;
    }

    await requireUser(request, reply);
  });

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

  app.post("/wallets", async (request, _reply): Promise<CreateWalletReply> => {
    const userId = request.userId ?? "anonymous";
    const walletId = stableId("wallet", userId);

    request.log.info({ event: "wallet.stub_returned", user_id: userId, wallet_id: walletId }, "wallet stub returned");

    return {
      wallet_id: walletId,
      user_id: userId,
      balance_paise: 0
    };
  });

  app.get<{ Params: { id: string } }>("/wallets/:id", async (request): Promise<WalletReply> => {
    const walletId = request.params.id;

    request.log.info({ event: "wallet.balance_stub_returned", wallet_id: walletId }, "wallet balance stub returned");

    return {
      wallet_id: walletId,
      balance_paise: 0
    };
  });

  app.post<{ Body: CreateTransferBody }>("/transfers", async (request, reply): Promise<TransferReply> => {
    const body = request.body;

    if (!body?.from || !body.to || !body.idempotency_key || !Number.isInteger(body.amount_paise) || body.amount_paise <= 0) {
      return reply.code(400).send({ error: "invalid_transfer_request" }) as never;
    }

    const transferId = stableId("transfer", body.idempotency_key);
    transfersCreatedTotal.inc();

    request.log.info(
      {
        event: "transfer.stub_created",
        transfer_id: transferId,
        from: body.from,
        to: body.to,
        amount_paise: body.amount_paise,
        idempotency_key: body.idempotency_key
      },
      "transfer stub created"
    );

    return {
      transfer_id: transferId,
      from: body.from,
      to: body.to,
      amount_paise: body.amount_paise,
      idempotency_key: body.idempotency_key,
      status: "succeeded"
    };
  });

  app.get<{ Params: { id: string } }>("/transfers/:id", async (request): Promise<TransferReply> => {
    const transferId = request.params.id;

    request.log.info({ event: "transfer.status_stub_returned", transfer_id: transferId }, "transfer status stub returned");

    return {
      transfer_id: transferId,
      from: "wallet_stub_from",
      to: "wallet_stub_to",
      amount_paise: 1,
      idempotency_key: stableId("idempotency", transferId),
      status: "pending"
    };
  });

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
