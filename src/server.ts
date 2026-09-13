import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { loadConfig, type AppConfig } from "./config.js";
import { checkDatabase, createPool } from "./db.js";
import {
  idempotentReplaysTotal,
  installMetricsHooks,
  register,
  transfersCreatedTotal,
  transfersDeclinedInsufficientFundsTotal
} from "./metrics.js";

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

type AdminSeedBody = {
  user_id: string;
  balance_paise: number;
};

type WalletRow = {
  id: string;
  user_id: string;
  balance_paise: string;
};

type TransferRow = {
  id: string;
  idempotency_key: string;
  request_hash: string;
  from_wallet_id: string;
  to_wallet_id: string;
  amount_paise: string;
  status: TransferReply["status"];
};

type TransferWithWalletsRow = TransferRow & {
  from_wallet_id: string;
  to_wallet_id: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function toSafeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`unsafe integer from database: ${value}`);
  }
  return parsed;
}

function transferRequestHash(body: CreateTransferBody): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ from: body.from, to: body.to, amount_paise: body.amount_paise }))
    .digest("hex");
}

function transferReply(row: TransferWithWalletsRow): TransferReply {
  return {
    transfer_id: row.id,
    from: row.from_wallet_id,
    to: row.to_wallet_id,
    amount_paise: toSafeNumber(row.amount_paise),
    idempotency_key: row.idempotency_key,
    status: row.status
  };
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
    if (request.url === "/healthz" || request.url === "/metrics" || request.url === "/admin/seed") {
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

  app.post("/wallets", async (request): Promise<CreateWalletReply> => {
    const userId = request.userId ?? "anonymous";
    const result = await pool.query<WalletRow>(
      `
        insert into wallets (user_id)
        values ($1)
        on conflict (user_id) do update
          set updated_at = wallets.updated_at
        returning id, user_id, balance_paise
      `,
      [userId]
    );
    const wallet = result.rows[0];

    request.log.info({ event: "wallet.get_or_create", user_id: userId, wallet_id: wallet.id }, "wallet returned");

    return {
      wallet_id: wallet.id,
      user_id: wallet.user_id,
      balance_paise: toSafeNumber(wallet.balance_paise)
    };
  });

  app.get<{ Params: { id: string } }>("/wallets/:id", async (request, reply): Promise<WalletReply> => {
    const walletId = request.params.id;

    if (!isUuid(walletId)) {
      return reply.code(400).send({ error: "invalid_wallet_id" }) as never;
    }

    const result = await pool.query<WalletRow>("select id, user_id, balance_paise from wallets where id = $1", [walletId]);
    const wallet = result.rows[0];

    if (!wallet) {
      return reply.code(404).send({ error: "wallet_not_found" }) as never;
    }

    request.log.info({ event: "wallet.balance_read", wallet_id: walletId }, "wallet balance returned");

    return {
      wallet_id: wallet.id,
      balance_paise: toSafeNumber(wallet.balance_paise)
    };
  });

  app.post<{ Body: CreateTransferBody }>("/transfers", async (request, reply): Promise<TransferReply> => {
    const body = request.body;

    if (
      !body ||
      !isUuid(body.from) ||
      !isUuid(body.to) ||
      body.from === body.to ||
      typeof body.idempotency_key !== "string" ||
      body.idempotency_key.length === 0 ||
      !isPositiveInteger(body.amount_paise)
    ) {
      return reply.code(400).send({ error: "invalid_transfer_request" }) as never;
    }

    const requestHash = transferRequestHash(body);
    const client = await pool.connect();

    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [body.idempotency_key]);

      const existing = await client.query<TransferWithWalletsRow>(
        `
          select id, idempotency_key, request_hash, from_wallet_id, to_wallet_id, amount_paise, status
          from transfers
          where idempotency_key = $1
        `,
        [body.idempotency_key]
      );

      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          await client.query("rollback");
          request.log.warn(
            { event: "transfer.idempotency_conflict", idempotency_key: body.idempotency_key },
            "idempotency key replayed with different body"
          );
          return reply.code(409).send({ error: "idempotency_key_conflict" }) as never;
        }

        await client.query("commit");
        idempotentReplaysTotal.inc();
        request.log.info(
          {
            event: "transfer.idempotent_replay_hit",
            transfer_id: existing.rows[0].id,
            idempotency_key: body.idempotency_key
          },
          "idempotent transfer replay returned"
        );
        return transferReply(existing.rows[0]);
      }

      const wallets = await client.query<WalletRow>(
        `
          select id, user_id, balance_paise
          from wallets
          where id = any($1::uuid[])
          order by id
          for update
        `,
        [[body.from, body.to]]
      );

      if (wallets.rows.length !== 2) {
        await client.query("rollback");
        return reply.code(404).send({ error: "wallet_not_found" }) as never;
      }

      const fromWallet = wallets.rows.find((wallet) => wallet.id === body.from);
      const toWallet = wallets.rows.find((wallet) => wallet.id === body.to);

      if (!fromWallet || !toWallet) {
        await client.query("rollback");
        return reply.code(404).send({ error: "wallet_not_found" }) as never;
      }

      const fromBalance = toSafeNumber(fromWallet.balance_paise);
      const status: TransferReply["status"] =
        fromBalance >= body.amount_paise ? "succeeded" : "declined_insufficient_funds";

      if (status === "succeeded") {
        await client.query("update wallets set balance_paise = balance_paise - $1, updated_at = now() where id = $2", [
          body.amount_paise,
          body.from
        ]);
        request.log.info(
          { event: "transfer.debited", from: body.from, amount_paise: body.amount_paise },
          "wallet debited"
        );

        await client.query("update wallets set balance_paise = balance_paise + $1, updated_at = now() where id = $2", [
          body.amount_paise,
          body.to
        ]);
        request.log.info(
          { event: "transfer.credited", to: body.to, amount_paise: body.amount_paise },
          "wallet credited"
        );
      }

      const created = await client.query<TransferWithWalletsRow>(
        `
          insert into transfers (
            idempotency_key,
            request_hash,
            from_wallet_id,
            to_wallet_id,
            amount_paise,
            status
          )
          values ($1, $2, $3, $4, $5, $6)
          returning id, idempotency_key, request_hash, from_wallet_id, to_wallet_id, amount_paise, status
        `,
        [body.idempotency_key, requestHash, body.from, body.to, body.amount_paise, status]
      );

      await client.query("commit");

      transfersCreatedTotal.inc();
      request.log.info(
        {
          event: "transfer.created",
          transfer_id: created.rows[0].id,
          from: body.from,
          to: body.to,
          amount_paise: body.amount_paise,
          idempotency_key: body.idempotency_key,
          status
        },
        "transfer created"
      );

      if (status === "declined_insufficient_funds") {
        transfersDeclinedInsufficientFundsTotal.inc();
        request.log.info(
          {
            event: "transfer.declined",
            reason: "insufficient_funds",
            transfer_id: created.rows[0].id,
            from: body.from,
            to: body.to,
            amount_paise: body.amount_paise,
            idempotency_key: body.idempotency_key
          },
          "transfer declined"
        );
      }

      return transferReply(created.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      request.log.error({ err: error, event: "transfer.failed" }, "transfer failed");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>("/transfers/:id", async (request, reply): Promise<TransferReply> => {
    const transferId = request.params.id;

    if (!isUuid(transferId)) {
      return reply.code(400).send({ error: "invalid_transfer_id" }) as never;
    }

    const result = await pool.query<TransferWithWalletsRow>(
      `
        select id, idempotency_key, request_hash, from_wallet_id, to_wallet_id, amount_paise, status
        from transfers
        where id = $1
      `,
      [transferId]
    );
    const transfer = result.rows[0];

    if (!transfer) {
      return reply.code(404).send({ error: "transfer_not_found" }) as never;
    }

    request.log.info({ event: "transfer.status_read", transfer_id: transferId }, "transfer status returned");

    return transferReply(transfer);
  });

  app.post<{ Body: AdminSeedBody }>("/admin/seed", async (request, reply): Promise<CreateWalletReply> => {
    if (request.headers["x-admin-token"] !== config.adminToken) {
      return reply.code(401).send({ error: "invalid_admin_token" }) as never;
    }

    const body = request.body;
    if (!body || typeof body.user_id !== "string" || body.user_id.length === 0 || !isNonNegativeInteger(body.balance_paise)) {
      return reply.code(400).send({ error: "invalid_seed_request" }) as never;
    }

    const result = await pool.query<WalletRow>(
      `
        insert into wallets (user_id, balance_paise)
        values ($1, $2)
        on conflict (user_id) do update
          set balance_paise = excluded.balance_paise,
              updated_at = now()
        returning id, user_id, balance_paise
      `,
      [body.user_id, body.balance_paise]
    );
    const wallet = result.rows[0];

    request.log.info(
      { event: "wallet.admin_seeded", user_id: wallet.user_id, wallet_id: wallet.id, balance_paise: body.balance_paise },
      "wallet seeded"
    );

    return {
      wallet_id: wallet.id,
      user_id: wallet.user_id,
      balance_paise: toSafeNumber(wallet.balance_paise)
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
