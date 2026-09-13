import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import type { AdminSeedBody, CreateWalletReply, WalletReply } from "../domain/types.js";
import { isNonNegativeInteger, isUuid } from "../domain/validation.js";
import { getOrCreateWallet, getWallet, seedWallet } from "../services/wallets.js";

export function registerWalletRoutes(app: FastifyInstance, pool: pg.Pool, config: AppConfig): void {
  app.post("/wallets", async (request): Promise<CreateWalletReply> => {
    const userId = request.userId ?? "anonymous";
    const wallet = await getOrCreateWallet(pool, userId);

    request.log.info({ event: "wallet.get_or_create", user_id: userId, wallet_id: wallet.wallet_id }, "wallet returned");

    return wallet;
  });

  app.get<{ Params: { id: string } }>("/wallets/:id", async (request, reply): Promise<WalletReply> => {
    const walletId = request.params.id;

    if (!isUuid(walletId)) {
      return reply.code(400).send({ error: "invalid_wallet_id" }) as never;
    }

    const wallet = await getWallet(pool, walletId);
    if (!wallet) {
      return reply.code(404).send({ error: "wallet_not_found" }) as never;
    }

    request.log.info({ event: "wallet.balance_read", wallet_id: walletId }, "wallet balance returned");
    return wallet;
  });

  app.post<{ Body: AdminSeedBody }>("/admin/seed", async (request, reply): Promise<CreateWalletReply> => {
    if (request.headers["x-admin-token"] !== config.adminToken) {
      return reply.code(401).send({ error: "invalid_admin_token" }) as never;
    }

    const body = request.body;
    if (!body || typeof body.user_id !== "string" || body.user_id.length === 0 || !isNonNegativeInteger(body.balance_paise)) {
      return reply.code(400).send({ error: "invalid_seed_request" }) as never;
    }

    const wallet = await seedWallet(pool, body);
    request.log.info(
      { event: "wallet.admin_seeded", user_id: wallet.user_id, wallet_id: wallet.wallet_id, balance_paise: body.balance_paise },
      "wallet seeded"
    );

    return wallet;
  });
}
